using System;
using System.Collections.Generic;
using AliyaPet.Models.Interaction;

namespace AliyaPet.Services.Interaction;

/// <summary>
/// 抚摸手势识别（纯逻辑，可测试）：
///   - 采样 30~60Hz，固定容量环形缓冲，只保留最近约 1 秒
///   - 有效条件：水平移动占主导（&gt;60%）、起始距离 6~10px、单次划动 18~80px、
///     水平速度 40~500px/s、至少一次有效方向反转
///   - 方向反转：最小反转距离 14~24px、防抖 80~160ms、忽略 &lt;3~5px 抖动
///   - 仅按住不移动不增加抚摸次数
/// </summary>
public sealed class PettingGestureRecognizer
{
    private readonly int _capacity;
    private readonly double _sampleWindowSeconds;
    private readonly double _minStartDistancePx = 8;       // 6~10
    private readonly double _minStrokeDistancePx = 18;     // 18~80
    private readonly double _maxStrokeDistanceLimitPx = 80;
    private readonly double _minVelocityPxPerSec = 40;     // 40~500
    private readonly double _maxVelocityPxPerSec = 500;
    private readonly double _horizontalDominance = 0.60;
    private readonly double _minReversalDistancePx = 18;   // 14~24
    private readonly double _reversalDebounceSeconds = 0.12; // 80~160ms
    private readonly double _jitterPx = 4;                  // 3~5

    private readonly LinkedList<PettingGestureSample> _samples = new();
    private bool _gestureActive;
    private double _startCumulative;
    private double _lastCumulative;
    private double _lastPxX;
    private double _lastPxY;
    private int _currentDirection;          // -1/0/1
    private int _lastNonZeroDirection;
    private double _strokeStartCumulative;  // 当前划动起点累计距离
    private double _lastReversalTime;
    private int _reversalCount;
    private double _maxStrokeDistancePx;    // 已完成的划动最大距离（18~80 内）
    private double _smoothedVelXPxPerSec;
    private double _gestureElapsed;

    public PettingGestureRecognizer(int capacity = 64, double sampleWindowSeconds = 1.0)
    {
        _capacity = capacity;
        _sampleWindowSeconds = sampleWindowSeconds;
    }

    public void StartGesture()
    {
        _gestureActive = true;
        _samples.Clear();
        _startCumulative = 0;
        _lastCumulative = 0;
        _lastPxX = 0;
        _lastPxY = 0;
        _currentDirection = 0;
        _lastNonZeroDirection = 0;
        _strokeStartCumulative = 0;
        _lastReversalTime = 0;
        _reversalCount = 0;
        _maxStrokeDistancePx = 0;
        _smoothedVelXPxPerSec = 0;
        _gestureElapsed = 0;
    }

    public void EndGesture()
    {
        _gestureActive = false;
        _samples.Clear();
        _smoothedVelXPxPerSec = 0;
        _currentDirection = 0;
    }

    public bool IsGestureActive => _gestureActive;

    /// <summary>当前平滑后的水平速度（物理像素/秒，供头部跟随与手掌旋转）。</summary>
    public double SmoothedVelXPxPerSec => _smoothedVelXPxPerSec;

    /// <summary>当前方向（-1/0/1）。</summary>
    public int CurrentDirection => _currentDirection;

    public int ReversalCount => _reversalCount;

    public double GestureElapsedSeconds => _gestureElapsed;

    public double CumulativeDistancePx => _gestureActive ? _lastCumulative - _startCumulative : 0;

    /// <summary>压入一个新采样并返回识别结果。</summary>
    public PettingGestureResult Update(InteractionContext ctx)
    {
        if (!_gestureActive)
            return PettingGestureResult.Invalid;

        // 使用调用方提供的帧间隔（真实帧率），保证确定性与可测试性
        double dt = Math.Max(0.001, ctx.DeltaSeconds);
        _gestureElapsed += dt;

        double dx = ctx.ViewportPxX - _lastPxX;
        double dy = ctx.ViewportPxY - _lastPxY;
        double distance = Math.Sqrt(dx * dx + dy * dy);

        double velX = dx / dt;
        double velY = dy / dt;
        _smoothedVelXPxPerSec = _smoothedVelXPxPerSec * 0.7 + Math.Clamp(velX, -800, 800) * 0.3;

        _lastPxX = ctx.ViewportPxX;
        _lastPxY = ctx.ViewportPxY;
        _lastCumulative += distance;

        // 方向判定：忽略 < jitterPx 的抖动
        if (Math.Abs(dx) >= _jitterPx)
            _currentDirection = dx > 0 ? 1 : -1;
        else if (distance < _jitterPx)
            _currentDirection = 0;

        // 方向反转检测：划动距离 = 距上次方向变化的累计距离
        bool reversed = false;
        if (_currentDirection != 0 && _lastNonZeroDirection != 0 && _currentDirection != _lastNonZeroDirection)
        {
            double strokeLen = _lastCumulative - _strokeStartCumulative;
            double timeSince = _gestureElapsed - _lastReversalTime;
            if (strokeLen >= _minReversalDistancePx && timeSince >= _reversalDebounceSeconds)
            {
                reversed = true;
                _reversalCount++;
                if (strokeLen >= _minStrokeDistancePx && strokeLen <= _maxStrokeDistanceLimitPx)
                    _maxStrokeDistancePx = Math.Max(_maxStrokeDistancePx, strokeLen);
                _strokeStartCumulative = _lastCumulative;
                _lastReversalTime = _gestureElapsed;
            }
        }
        else if (_currentDirection != 0 && _lastNonZeroDirection == 0)
        {
            // 首次产生方向：标记当前划动起点
            _strokeStartCumulative = _lastCumulative;
            _lastReversalTime = _gestureElapsed;
        }
        if (_currentDirection != 0)
            _lastNonZeroDirection = _currentDirection;

        var sample = new PettingGestureSample(
            _gestureElapsed, ctx.NormX, ctx.NormY, ctx.ViewportPxX, ctx.ViewportPxY,
            velX, velY, _currentDirection, _lastCumulative);
        _samples.AddLast(sample);
        if (_samples.Count > _capacity)
            _samples.RemoveFirst();
        // 只保留最近约 1 秒
        while (_samples.First is not null && _gestureElapsed - _samples.First.Value.TimeSeconds > _sampleWindowSeconds)
            _samples.RemoveFirst();

        bool isValid = EvaluateGesture(out double strokeDistance, out double horizontalRatio);
        return new PettingGestureResult(
            isValid, reversed, _currentDirection, _smoothedVelXPxPerSec,
            _lastCumulative - _startCumulative, strokeDistance);
    }

    private bool EvaluateGesture(out double strokeDistance, out double horizontalRatio)
    {
        strokeDistance = 0;
        horizontalRatio = 0;
        if (_samples.Count < 2)
            return false;

        double total = 0;
        double horizontal = 0;
        var node = _samples.First;
        var prev = node!.Value;
        node = node.Next;
        while (node is not null)
        {
            var cur = node.Value;
            double ddx = cur.ViewportPxX - prev.ViewportPxX;
            double ddy = cur.ViewportPxY - prev.ViewportPxY;
            double seg = Math.Sqrt(ddx * ddx + ddy * ddy);
            total += seg;
            horizontal += Math.Abs(ddx);
            prev = cur;
            node = node.Next;
        }

        if (total < _minStartDistancePx)
            return false;
        horizontalRatio = total > 0 ? horizontal / total : 0;
        if (horizontalRatio < _horizontalDominance)
            return false;

        // 水平速度 40~500px/s（取平滑速度）
        double vel = Math.Abs(_smoothedVelXPxPerSec);
        if (vel < _minVelocityPxPerSec || vel > _maxVelocityPxPerSec)
            return false;

        // 至少一次有效方向反转；且存在一段划动距离在 18~80px
        if (_reversalCount <= 0)
            return false;
        strokeDistance = _maxStrokeDistancePx;
        if (strokeDistance < _minStrokeDistancePx || strokeDistance > _maxStrokeDistanceLimitPx)
            return false;

        return true;
    }
}
