using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using AliyaPet.Models.Mouth;

namespace AliyaPet.Services.Mouth;

/// <summary>
/// 嘴型时间轴播放器：按时间平滑写入 Live2D 嘴部参数。
///   - 时间相关的指数平滑（不依赖固定帧率，张嘴 50~90ms、闭嘴 80~140ms、句末闭合 100~180ms）
///   - 台词结束后闭嘴；会话被取消时 100~150ms 内闭合
///   - 单实例运行，同一时刻只有本播放器写参数（新会话先停止旧会话）
/// </summary>
public sealed class MouthAnimationRunner
{
    private const int TickMilliseconds = 33;
    private const int StartDelayMilliseconds = 60;   // 气泡先显示，约 50~100ms 后启动嘴型

    private readonly IMouthController _mouth;
    private readonly DispatcherTimer _timer;
    private readonly Stopwatch _stopwatch = new();
    private readonly Random _random = new();

    private MouthTimeline? _timeline;
    private CancellationToken _token;
    private TaskCompletionSource<bool>? _completion;
    private bool _closing;
    private long _closeStartMs;
    private long _lastTickMs;
    private double _currentOpenY;
    private double _currentForm;

    private static readonly TimeSpan OpenTau = TimeSpan.FromMilliseconds(70);
    private static readonly TimeSpan CloseTau = TimeSpan.FromMilliseconds(110);

    public MouthAnimationRunner(IMouthController mouth)
    {
        _mouth = mouth;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(TickMilliseconds) };
        _timer.Tick += (_, _) => Tick();
    }

    /// <summary>启动一次会话，返回完成信号（台词结束并闭嘴后完成）。会先停止旧会话。</summary>
    public Task StartSession(MouthTimeline timeline, CancellationToken token)
    {
        StopCurrent();

        _timeline = timeline;
        _token = token;
        _completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _closing = false;
        _currentOpenY = 0;
        _currentForm = 0;
        _stopwatch.Restart();
        _lastTickMs = 0;
        _timer.Start();

        return _completion.Task;
    }

    /// <summary>立即停止并释放嘴型通道（应用退出 / 切换角色等）。</summary>
    public void StopNow()
    {
        StopCurrent();
    }

    private void StopCurrent()
    {
        _timer.Stop();
        _timeline = null;
        _closing = false;
        _mouth.Release();
        var completion = _completion;
        _completion = null;
        completion?.TrySetResult(false);
    }

    private void Tick()
    {
        if (_timeline is null)
        {
            _timer.Stop();
            return;
        }

        if (_token.IsCancellationRequested)
        {
            BeginClose();
        }

        long nowMs = _stopwatch.ElapsedMilliseconds;
        long elapsed = nowMs - StartDelayMilliseconds;
        double dt = Math.Max(1, nowMs - _lastTickMs) / 1000.0;
        _lastTickMs = nowMs;

        if (_closing)
        {
            var frame = SmoothTowards(MouthAnimationFrame.Closed, dt);
            _mouth.Write(frame);
            if (nowMs - _closeStartMs >= 150)
                FinishSession();
            return;
        }

        if (elapsed < 0)
        {
            // 启动延迟：嘴巴保持闭合，不进入闭合状态
            _mouth.Write(MouthAnimationFrame.Closed);
            return;
        }

        if (elapsed >= _timeline.TotalMilliseconds)
        {
            BeginClose();
            var closingFrame = SmoothTowards(MouthAnimationFrame.Closed, dt);
            _mouth.Write(closingFrame);
            return;
        }

        var target = FindTarget(elapsed);
        var current = SmoothTowards(target, dt);
        _mouth.Write(current);
    }

    private MouthAnimationFrame SmoothTowards(MouthAnimationFrame target, double dt)
    {
        var tau = target.OpenY >= _currentOpenY ? OpenTau : CloseTau;
        double k = 1.0 - Math.Exp(-dt / tau.TotalSeconds);
        _currentOpenY += (target.OpenY - _currentOpenY) * k;
        _currentForm += (target.Form - _currentForm) * k;

        // 轻微稳定随机变化：开合幅度 ±5%
        double wobble = 1.0 + (_random.NextDouble() - 0.5) * 0.10;
        return new MouthAnimationFrame(
            Math.Clamp(_currentOpenY * wobble, 0, 1),
            Math.Clamp(_currentForm, -1, 1));
    }

    private MouthAnimationFrame FindTarget(long elapsedMs)
    {
        foreach (var item in _timeline!.Items)
        {
            if (elapsedMs >= item.StartMilliseconds && elapsedMs < item.EndMilliseconds)
            {
                return new MouthAnimationFrame(item.Shape.OpenY, item.Shape.Form);
            }
        }
        var last = _timeline.Items[^1];
        return new MouthAnimationFrame(last.Shape.OpenY, last.Shape.Form);
    }

    private void BeginClose()
    {
        if (_closing)
            return;
        _closing = true;
        _closeStartMs = _stopwatch.ElapsedMilliseconds;
    }

    private void FinishSession()
    {
        _timer.Stop();
        _timeline = null;
        _closing = false;
        _currentOpenY = 0;
        _currentForm = 0;
        _mouth.Release();
        var completion = _completion;
        _completion = null;
        completion?.TrySetResult(true);
    }
}
