using System;
using System.Windows.Threading;
using AliyaPet.Models.Dialogue;
using AliyaPet.Models.Interaction;
using AliyaPet.Rendering;
using AliyaPet.Services.Dialogue;

namespace AliyaPet.Services.Interaction;

/// <summary>抚摸台词宿主（由 MainWindow 实现：取消当前会话并播放）。</summary>
public interface IPettingDialogueHost
{
    /// <summary>当前是否正在播放高优先级台词（抚摸开始台词不打断它）。</summary>
    bool IsDialogueActive { get; }

    /// <summary>播放一条抚摸台词（会取消之前的台词会话，气泡由统一管道控制）。</summary>
    void PlayPettingDialogue(ResolvedDialogue resolved);
}

/// <summary>
/// 抚摸模式状态机：
///   Inactive → Armed → HoveringHead → Pressed → Petting → Finishing → Armed
///   任意状态 Esc / 再次点击按钮 / 切换角色 / 重载模型 / 关闭 → Inactive
/// 所有结束路径统一走 EndPettingSession(PettingEndReason)，不得在多个事件中分散复制恢复代码。
/// </summary>
public sealed class HeadPettingService
{
    private readonly HitAreaService _hitArea;
    private readonly PettingGestureRecognizer _recognizer;
    private readonly PettingReactionController _reaction;
    private readonly InteractionStateService _stateService;
    private readonly DialoguePlaybackService _playback;
    private readonly IPettingDialogueHost _host;
    private readonly Random _random = new();
    private readonly DispatcherTimer _timer;

    private DateTime _sessionStart;
    private long _sessionElapsedMs;
    private long _lastSoftOrActiveMs;
    private int _softActiveCount;
    private bool _fastTriggered;
    private bool _longTriggered;
    private bool _endDialogueTriggered;
    private DateTime _finishingStart;
    private bool _sessionEnding;
    private DateTime? _lastGestureUtc;

    public HeadPettingService(
        HitAreaService hitArea,
        PettingGestureRecognizer recognizer,
        PettingReactionController reaction,
        InteractionStateService stateService,
        DialoguePlaybackService playback,
        IPettingDialogueHost host)
    {
        _hitArea = hitArea;
        _recognizer = recognizer;
        _reaction = reaction;
        _stateService = stateService;
        _playback = playback;
        _host = host;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        _timer.Tick += (_, _) => UpdateTimer();
    }

    public PettingState State { get; private set; } = PettingState.Inactive;

    public bool IsPettingModeActive => State != PettingState.Inactive;

    /// <summary>当前是否有激活的抚摸会话（Pressed/Petting/Finishing）。</summary>
    public bool IsPettingSessionActive => State is PettingState.Pressed or PettingState.Petting or PettingState.Finishing;

    public event Action<bool>? PettingModeChanged;

    /// <summary>抚摸会话结束事件（MainWindow 用于释放鼠标捕获与更新光标）。</summary>
    public event Action<PettingEndReason>? SessionEnded;

    /// <summary>最近一次有效手势采样时间（安全兜底用）。</summary>
    public DateTime? LastActiveGestureUtc => _lastGestureUtc;

    /// <summary>当前平滑水平速度（供手掌指针旋转）。</summary>
    public double SmoothedVelocityXPxPerSec => _recognizer.SmoothedVelXPxPerSec;

    public void EnterPettingMode()
    {
        if (State == PettingState.Inactive)
        {
            _stateService.EnsureFresh();
            SetState(PettingState.Armed);
            PettingModeChanged?.Invoke(true);
            _reaction.Start();
            AppLog.Info("PETTING_MODE_ENTER armed");
        }
        else
        {
            ExitPettingMode("toggle_off");
        }
    }

    public void ExitPettingMode(string reason)
    {
        if (State == PettingState.Inactive)
            return;
        // 会话激活时先走统一结束恢复，再进入 Inactive
        if (IsPettingSessionActive)
            EndPettingSession(MapExitReason(reason));
        CancelGesture();
        _reaction.ResetAll();
        _reaction.Stop();
        _timer.Stop();
        _sessionEnding = false;
        SetState(PettingState.Inactive);
        PettingModeChanged?.Invoke(false);
        AppLog.Info("PETTING_MODE_EXIT reason={0}", reason);
    }

    /// <summary>指针移动。返回 true 表示互动已接管（MainWindow 不再移动窗口）。
    /// 移出容错区域的结束判断由 MainWindow 依据统一窗口坐标执行。</summary>
    public bool OnPointerMove(InteractionContext ctx)
    {
        if (!IsPettingModeActive)
            return false;

        if (State is PettingState.Armed or PettingState.HoveringHead or PettingState.Finishing)
        {
            bool inZone = _hitArea.IsInArea("head_pet_zone", ctx.NormX, ctx.NormY);
            if (State == PettingState.Armed && inZone)
                SetState(PettingState.HoveringHead);
            else if (State == PettingState.HoveringHead && !inZone)
                SetState(PettingState.Armed);
        }

        if (State is PettingState.Pressed or PettingState.Petting)
        {
            var result = _recognizer.Update(ctx);
            _lastGestureUtc = DateTime.UtcNow;
            _reaction.SetVelocity(result.SmoothedVelXPxPerSec, petting: true);
            if (result.IsValid && State == PettingState.Pressed)
            {
                SetState(PettingState.Petting);
                OnPettingStarted();
            }
            return true;
        }
        return false;
    }

    /// <summary>左键按下。返回 true 表示互动已接管（MainWindow 不开始拖动/单击）。</summary>
    public bool OnPointerDown(InteractionContext ctx)
    {
        if (!IsPettingModeActive)
            return false;

        if (State is PettingState.Armed or PettingState.HoveringHead or PettingState.Finishing)
        {
            bool inZone = _hitArea.IsInArea("head_pet_zone", ctx.NormX, ctx.NormY);
            if (inZone)
            {
                _sessionEnding = false; // 先取消旧恢复再创建新会话（单 EyeOverride 动画）
                _sessionStart = DateTime.Now;
                _sessionElapsedMs = 0;
                _softActiveCount = 0;
                _lastSoftOrActiveMs = 0;
                _fastTriggered = false;
                _longTriggered = false;
                _endDialogueTriggered = false;
                _lastGestureUtc = DateTime.UtcNow;
                _recognizer.StartGesture();
                _reaction.BeginEyeClose();
                _stateService.BeginPetting();
                SetState(PettingState.Pressed);
                return true;
            }
            // 按住身体区域：不判为抚摸，交还 MainWindow（正常拖动/单击）
            return false;
        }
        return false;
    }

    /// <summary>左键松开。返回 true 表示互动已接管。</summary>
    public bool OnPointerUp(InteractionContext ctx)
    {
        if (State is PettingState.Pressed or PettingState.Petting)
        {
            EndPettingSession(PettingEndReason.MouseReleased);
            return true;
        }
        return false;
    }

    /// <summary>
    /// 统一结束方法：停止采样/清空样本 → Finishing → 睁眼恢复 → 头部/耳朵回正 → 释放捕获 → 更新光标。
    /// 所有结束路径（MouseUp/移出/捕获丢失/失焦/模式切换/Esc/角色/关闭/Native 错误）都必须调用。
    /// </summary>
    public void EndPettingSession(PettingEndReason reason)
    {
        if (!IsPettingSessionActive || _sessionEnding)
            return;
        _sessionEnding = true;

        // 1-2. 停止轨迹采样并清空样本
        _recognizer.EndGesture();
        // 3. 状态切换为 Finishing（参数恢复由 PettingReactionController 平滑完成）
        SetState(PettingState.Finishing);
        // 4-7. 取消参数更新：头部/耳朵目标归 0、EyeOverride 平滑睁眼
        _reaction.SetVelocity(0, petting: false);
        _reaction.BeginEyeOpen();

        long durationMs = (long)(DateTime.Now - _sessionStart).TotalMilliseconds;
        _stateService.EndPetting(durationMs);

        // 结束台词：仅用户主动结束（松开 / 移出容错区）且时长 > 1s 时小概率触发
        if (durationMs > 1000 && !_endDialogueTriggered
            && reason is PettingEndReason.MouseReleased or PettingEndReason.PointerOutsideTolerance
            && _random.NextDouble() < 0.30)
        {
            _endDialogueTriggered = true;
            PlayTag("petting_end");
        }

        _finishingStart = DateTime.Now;
        AppLog.Info("PETTING_SESSION_END reason={0}", reason);
        // 10-11. 释放人物层鼠标捕获 + 更新光标（由 MainWindow 处理）
        SessionEnded?.Invoke(reason);
    }

    public void OnEsc()
    {
        if (IsPettingModeActive)
            ExitPettingMode("esc");
    }

    private void OnPettingStarted()
    {
        if (_host.IsDialogueActive)
            return;
        if (_random.NextDouble() >= 0.40)
            return;

        int count = _stateService.PettingCountToday;
        double repeatChance = count >= 2 ? Math.Min(0.8, 0.25 + 0.15 * (count - 2)) : 0;
        string tag = _random.NextDouble() < repeatChance ? "petting_repeat" : "petting_start";
        double boost = tag == "petting_repeat" ? count : 0;
        PlayTag(tag, boost);
    }

    private void UpdateTimer()
    {
        if (!IsPettingModeActive)
            return;

        if (State == PettingState.Finishing)
        {
            // 恢复参数（约 600ms）后回到 Armed
            if ((DateTime.Now - _finishingStart).TotalMilliseconds >= 600)
            {
                _sessionEnding = false;
                SetState(PettingState.Armed);
            }
            return;
        }

        if (State != PettingState.Petting)
            return;

        _sessionElapsedMs += 33;

        // 持续过快 0.8s 以上：每次会话最多一条 petting_fast
        if (!_fastTriggered && _sessionElapsedMs > 800 && Math.Abs(_recognizer.SmoothedVelXPxPerSec) > 250)
        {
            _fastTriggered = true;
            PlayTag("petting_fast");
            return;
        }

        // 持续约 10 秒：每次会话最多一条 petting_long
        if (!_longTriggered && _sessionElapsedMs >= 10000)
        {
            _longTriggered = true;
            PlayTag("petting_long");
            return;
        }

        // 持续 2~4 秒起触发 petting_soft / petting_active；最多 2 条，间隔至少 4 秒
        if (_softActiveCount < 2 && _sessionElapsedMs >= 2000
            && _sessionElapsedMs - _lastSoftOrActiveMs >= 4000
            && !_host.IsDialogueActive
            && _random.NextDouble() < 0.6)
        {
            _softActiveCount++;
            _lastSoftOrActiveMs = _sessionElapsedMs;
            string tag = _random.NextDouble() < 0.5 ? "petting_soft" : "petting_active";
            PlayTag(tag);
        }
    }

    private void PlayTag(string tag, double boost = 0)
    {
        var resolved = _playback.ResolveSceneTag(
            "head_petting", tag, _stateService.State.LastPettingDialogueIds, boost);
        if (resolved is null)
            return;
        _stateService.RecordDialogueId(resolved.Entry.Id ?? "");
        _host.PlayPettingDialogue(resolved);
    }

    private static PettingEndReason MapExitReason(string reason) => reason switch
    {
        "esc" => PettingEndReason.EscapePressed,
        "model_reload" => PettingEndReason.NativeError,
        "window_closed" => PettingEndReason.WindowClosing,
        "switch_character" => PettingEndReason.CharacterChanged,
        "toggle_off" => PettingEndReason.ModeChanged,
        _ => PettingEndReason.ModeChanged
    };

    private void CancelGesture()
    {
        _recognizer.EndGesture();
        _timer.Stop();
    }

    private void SetState(PettingState state)
    {
        if (State == state)
            return;
        State = state;
        if (IsPettingModeActive && state == PettingState.Petting)
            _timer.Start();
        else if (state == PettingState.Finishing)
            _timer.Start();
        else if (state == PettingState.Armed)
            _timer.Start();
        else if (state == PettingState.Inactive)
            _timer.Stop();
    }
}
