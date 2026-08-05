namespace AliyaPet.Models.Interaction;

/// <summary>抚摸手势识别结果。</summary>
public readonly struct PettingGestureResult
{
    public PettingGestureResult(
        bool isValid,
        bool directionReversed,
        int direction,
        double smoothedVelXPxPerSec,
        double startDistancePx,
        double strokeDistancePx)
    {
        IsValid = isValid;
        DirectionReversed = directionReversed;
        Direction = direction;
        SmoothedVelXPxPerSec = smoothedVelXPxPerSec;
        StartDistancePx = startDistancePx;
        StrokeDistancePx = strokeDistancePx;
    }

    public static PettingGestureResult Invalid { get; } = new(false, false, 0, 0, 0, 0);

    /// <summary>本次是否为有效抚摸（水平主导 + 起始距离足够 + 速度在范围内）。</summary>
    public bool IsValid { get; }

    /// <summary>是否发生了有效方向反转（抚摸计数 +1 的条件之一）。</summary>
    public bool DirectionReversed { get; }

    /// <summary>当前方向：-1 左 / 1 右。</summary>
    public int Direction { get; }

    /// <summary>平滑后的水平速度（物理像素/秒，供头部跟随）。</summary>
    public double SmoothedVelXPxPerSec { get; }

    /// <summary>起始移动距离（物理像素）。</summary>
    public double StartDistancePx { get; }

    /// <summary>本次有效划动距离（物理像素）。</summary>
    public double StrokeDistancePx { get; }
}
