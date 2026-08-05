using System;
using System.Windows.Threading;
using AliyaPet.Models.Interaction;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Interaction;

/// <summary>
/// 程序化互动反应：点击 head（闭眼+头部倾斜）、face（短暂移开视线）、耳朵（小幅耳动）、
/// 快速拖动（睁大）、连续点击（疑惑）。通过同一组 Native 互动通道实现，不新增动作 JSON。
/// </summary>
public sealed class ProceduralReactionService
{
    private readonly Func<Live2DCharacterRenderer?> _getRenderer;
    private readonly Func<bool> _isPettingActive;
    private readonly Func<string, bool> _playCharacterAction;
    private readonly DispatcherTimer _timer;
    private readonly object _gate = new();

    private readonly struct Phase
    {
        public Phase(int durationMs, double eyeOpen, double headX, double headY, double headZ, double earL, double earR)
        {
            DurationMs = durationMs;
            EyeOpen = eyeOpen;
            HeadX = headX;
            HeadY = headY;
            HeadZ = headZ;
            EarL = earL;
            EarR = earR;
        }

        public int DurationMs { get; }
        public double EyeOpen { get; }
        public double HeadX { get; }
        public double HeadY { get; }
        public double HeadZ { get; }
        public double EarL { get; }
        public double EarR { get; }
    }

    private static readonly Phase Neutral = new(0, 1, 0, 0, 0, 0, 0);

    private readonly List<Phase> _phases = new();
    private int _phaseIndex;
    private long _phaseStartMs;
    private Phase _prev;

    // 当前实际写入值（平滑）
    private double _eyeOpen = 1, _headX, _headY, _headZ, _earL, _earR;
    private bool _eyeOverrideActive;

    public ProceduralReactionService(
        Func<Live2DCharacterRenderer?> getRenderer,
        Func<bool> isPettingActive,
        Func<string, bool> playCharacterAction)
    {
        _getRenderer = getRenderer;
        _isPettingActive = isPettingActive;
        _playCharacterAction = playCharacterAction;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        _timer.Tick += (_, _) => Tick();
    }

    /// <summary>应用一个程序化反应。</summary>
    public void Apply(ProceduralReaction reaction)
    {
        if (_isPettingActive())
            return; // 抚摸模式期间不叠加程序化反应

        var renderer = _getRenderer();
        if (renderer is null)
            return;

        switch (reaction.Type)
        {
            case ProceduralReactionType.HeadTiltAndEyes:
                Start(new List<Phase>
                {
                    new(180, 0.2, 2.5, 0, -3, 0, 0),
                    new(320, 0.25, 2.5, 0, -3, 0, 0),
                    new(320, 1.0, 0, 0, 0, 0, 0)
                });
                break;
            case ProceduralReactionType.LookAtThenAway:
                Start(new List<Phase>
                {
                    new(180, 1.0, 0, 1.8, 0, 0, 0),
                    new(300, 1.0, 0, 1.8, 0, 0, 0),
                    new(300, 1.0, 0, -1.2, 0, 0, 0)
                });
                break;
            case ProceduralReactionType.EarTwitch:
            {
                bool left = reaction.AreaId == "ear_left";
                Start(new List<Phase>
                {
                    new(120, 1.0, 0, 0, left ? -1.5 : 1.5, left ? 0.8 : 0, left ? 0 : 0.8),
                    new(200, 1.0, 0, 0, 0, 0, 0)
                });
                break;
            }
            case ProceduralReactionType.EyesWiden:
                Start(new List<Phase>
                {
                    new(180, 1.0, 0, 0, 0, 0, 0),
                    new(260, 1.0, 0, 0, 0, 0, 0),
                    new(1, 1.0, 0, 0, 0, 0, 0)
                });
                break;
            case ProceduralReactionType.Doubt:
                _playCharacterAction("doubt");
                Start(new List<Phase>
                {
                    new(200, 0.4, -3, 0, 4, 0, 0),
                    new(400, 0.45, -3, 0, 4, 0, 0),
                    new(300, 1.0, 0, 0, 0, 0, 0)
                });
                break;
        }
    }

    public void CancelAll()
    {
        lock (_gate)
        {
            _phases.Clear();
            _phaseIndex = 0;
            _eyeOverrideActive = false;
            _eyeOpen = 1;
            _headX = _headY = _headZ = _earL = _earR = 0;
        }
        var renderer = _getRenderer();
        if (renderer is not null)
        {
            try
            {
                renderer.SetInteractionOffsets(0, 0, 0, 0);
                renderer.SetEyeOverride(false, 0, 0);
                renderer.SetEarInteraction(false, 0, 0);
            }
            catch { }
        }
        _timer.Stop();
    }

    private void Start(List<Phase> phases)
    {
        lock (_gate)
        {
            _phases.Clear();
            _phases.AddRange(phases);
            _phaseIndex = 0;
            _phaseStartMs = Environment.TickCount64;
            _prev = Neutral;
            _eyeOverrideActive = true;
            if (_phases.Count == 0)
                _phases.Add(Neutral);
        }
        _timer.Start();
    }

    private void Tick()
    {
        var renderer = _getRenderer();
        if (renderer is null)
        {
            _timer.Stop();
            return;
        }

        lock (_gate)
        {
            if (_phases.Count == 0)
            {
                _timer.Stop();
                return;
            }

            long now = Environment.TickCount64;
            double t = (now - _phaseStartMs) / 1000.0;
            if (_phaseIndex >= _phases.Count)
            {
                // 已结束：回到中性
                _eyeOpen = 1;
                _headX = _headY = _headZ = _earL = _earR = 0;
                _eyeOverrideActive = false;
                _phases.Clear();
                _timer.Stop();
            }
            else
            {
                var phase = _phases[_phaseIndex];
                double k = Math.Min(1.0, t / Math.Max(0.001, phase.DurationMs / 1000.0));
                var target = phase;
                _eyeOpen = _prev.EyeOpen + (target.EyeOpen - _prev.EyeOpen) * k;
                _headX = _prev.HeadX + (target.HeadX - _prev.HeadX) * k;
                _headY = _prev.HeadY + (target.HeadY - _prev.HeadY) * k;
                _headZ = _prev.HeadZ + (target.HeadZ - _prev.HeadZ) * k;
                _earL = _prev.EarL + (target.EarL - _prev.EarL) * k;
                _earR = _prev.EarR + (target.EarR - _prev.EarR) * k;

                if (k >= 1.0)
                {
                    _prev = target;
                    _phaseIndex++;
                    _phaseStartMs = now;
                }
            }
        }

        try
        {
            renderer.SetInteractionOffsets(_headX, _headY, _headZ, 0);
            if (_eyeOverrideActive)
                renderer.SetEyeOverride(true, _eyeOpen, _eyeOpen);
            else
                renderer.SetEyeOverride(false, 0, 0);
            renderer.SetEarInteraction(_earL != 0 || _earR != 0, _earL, _earR);
        }
        catch
        {
            // 写入失败忽略
        }
    }
}
