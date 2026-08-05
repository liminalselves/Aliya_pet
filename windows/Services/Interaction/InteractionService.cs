using System;
using AliyaPet.Models.Dialogue;
using AliyaPet.Models.Interaction;
using AliyaPet.Rendering;
using AliyaPet.Services.Dialogue;

namespace AliyaPet.Services.Interaction;

/// <summary>
/// 人物互动统一入口：区域识别、手势识别、台词抽取与参数动画全部集中在此服务。
/// MainWindow 仅转发鼠标输入并负责指针/气泡/手掌指针的呈现。
/// </summary>
public sealed class InteractionService
{
    private readonly HitAreaService _hitArea;
    private readonly ClickSequenceService _clickSequence;
    private readonly PointerProximityService _proximity;
    private readonly LongPressService _longPress;
    private readonly DragReactionService _dragReaction;
    private readonly HeadPettingService _headPetting;
    private readonly PettingReactionController _reaction;
    private readonly ProceduralReactionService _procedural;
    private readonly InteractionStateService _stateService;

    /// <summary>点击台词请求（MainWindow 提供：播放一条 user_click 台词）。</summary>
    public Action? PlayClickDialogue { get; set; }

    /// <summary>当前是否有台词在播放（MainWindow 提供）。</summary>
    public Func<bool>? IsDialogueActive { get; set; }

    public InteractionService(
        HitAreaService hitArea,
        ClickSequenceService clickSequence,
        PointerProximityService proximity,
        LongPressService longPress,
        DragReactionService dragReaction,
        HeadPettingService headPetting,
        PettingReactionController reaction,
        ProceduralReactionService procedural,
        InteractionStateService stateService)
    {
        _hitArea = hitArea;
        _clickSequence = clickSequence;
        _proximity = proximity;
        _longPress = longPress;
        _dragReaction = dragReaction;
        _headPetting = headPetting;
        _reaction = reaction;
        _procedural = procedural;
        _stateService = stateService;
    }

    public HitAreaService HitArea => _hitArea;
    public HeadPettingService HeadPetting => _headPetting;
    public LongPressService LongPress => _longPress;
    public InteractionStateService State => _stateService;
    public PettingReactionController Reaction => _reaction;

    public bool IsPettingModeActive => _headPetting.IsPettingModeActive;

    public event Action<bool>? PettingModeChanged
    {
        add => _headPetting.PettingModeChanged += value;
        remove => _headPetting.PettingModeChanged -= value;
    }

    /// <summary>当前平滑水平速度（供手掌指针旋转）。</summary>
    public double SmoothedVelocityXPxPerSec => _headPetting.SmoothedVelocityXPxPerSec;

    /// <summary>加载互动配置（相对 Assets 根目录）。</summary>
    public void Initialize(string assetsRoot)
    {
        _hitArea.LoadFromDirectory(assetsRoot);
        _stateService.EnsureFresh();
    }

    /// <summary>指针进入。返回 true=已接管。</summary>
    public bool OnPointerEnter(InteractionContext ctx)
    {
        _proximity.Update(ctx);
        return false;
    }

    public void OnPointerLeave()
    {
        _proximity.Reset();
    }

    /// <summary>指针移动。返回 true=互动已接管（MainWindow 不移动窗口/不处理拖动）。</summary>
    public bool OnPointerMove(InteractionContext ctx)
    {
        _proximity.Update(ctx);
        if (_headPetting.OnPointerMove(ctx))
            return true;
        return false;
    }

    /// <summary>左键按下。返回 true=互动已接管（MainWindow 不开始拖动/长按）。</summary>
    public bool OnPointerDown(InteractionContext ctx)
    {
        _proximity.Update(ctx);
        if (_headPetting.OnPointerDown(ctx))
            return true;
        if (!IsPettingModeActive)
        {
            _longPress.Start();
            _dragReaction.BeginDrag();
        }
        return false;
    }

    /// <summary>左键松开。返回 true=互动已接管（MainWindow 不处理单击/贴边）。</summary>
    public bool OnPointerUp(InteractionContext ctx)
    {
        _proximity.Update(ctx);
        if (_headPetting.OnPointerUp(ctx))
            return true;
        _longPress.Cancel();
        return false;
    }

    /// <summary>长按检测（MainWindow 定时调用）。</summary>
    public bool CheckLongPressFired()
    {
        if (_headPetting.IsPettingModeActive)
        {
            _longPress.Cancel();
            return false;
        }
        return _longPress.CheckFired();
    }

    /// <summary>普通单击（非抚摸接管，MainWindow 在单击确认后调用）。
    /// 返回 true 表示应抑制常规点击台词（点击冷却/疑惑反应等）。</summary>
    public bool OnClick(InteractionContext ctx, bool wasDrag)
    {
        if (wasDrag)
        {
            var (wasFast, _) = _dragReaction.EndDrag();
            if (wasFast)
            {
                _procedural.Apply(ProceduralReaction.EyesWiden(1.0));
                // 每次拖动最多触发一次台词
                if ((IsDialogueActive?.Invoke() ?? false) == false)
                    PlayClickDialogue?.Invoke();
            }
            return false;
        }

        var result = _clickSequence.RegisterClick();
        if (result == ClickSequenceService.ClickResult.Cooldown)
        {
            AppLog.Info("CLICK_COOLDOWN_ACTIVE 点击冷却中，抑制点击台词");
            return true;
        }

        var area = _hitArea.HitAreaAt(ctx.NormX, ctx.NormY);
        switch (area)
        {
            case "head":
                _procedural.Apply(ProceduralReaction.HeadTiltAndEyes(0.8));
                break;
            case "face":
                _procedural.Apply(ProceduralReaction.LookAtThenAway(0.6));
                break;
            case "ear_left":
            case "ear_right":
                _procedural.Apply(ProceduralReaction.EarTwitch(0.8, area));
                break;
        }

        if (result == ClickSequenceService.ClickResult.Doubt)
        {
            _procedural.Apply(ProceduralReaction.Doubt(0.9));
            return true; // 疑惑反应替代常规点击台词
        }
        return false;
    }

    public void OnEsc()
    {
        _headPetting.OnEsc();
    }

    public void TogglePettingMode()
    {
        _headPetting.EnterPettingMode();
    }

    public void ExitPettingMode(string reason)
    {
        _headPetting.ExitPettingMode(reason);
    }

    /// <summary>切换角色 / 重载 Live2D 模型时调用：退出抚摸并重置互动参数。</summary>
    public void OnModelReloaded()
    {
        ExitPettingMode("model_reload");
        _reaction.ResetConfiguration();
        _procedural.CancelAll();
    }

    /// <summary>隐藏人物 / 关闭窗口时调用：完整清理，不残留定时器与参数覆盖。</summary>
    public void OnWindowClosed()
    {
        ExitPettingMode("window_closed");
        _procedural.CancelAll();
        _clickSequence.Reset();
        _longPress.Cancel();
        _proximity.Reset();
    }

    /// <summary>设置命中区域调试开关（半透明轮廓）。</summary>
    public void SetHitAreaDebug(bool enabled)
    {
        _hitArea.SetDebugEnabled(enabled);
    }
}
