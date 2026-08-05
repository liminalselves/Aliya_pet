namespace AliyaPet.Models.Interaction;

/// <summary>一次抚摸轨迹采样（固定容量环形缓冲，只保留最近约 1 秒）。</summary>
public readonly struct PettingGestureSample
{
    public PettingGestureSample(
        double timeSeconds,
        double normX, double normY,
        double viewportPxX, double viewportPxY,
        double velXPxPerSec, double velYPxPerSec,
        int direction, double cumulativeDistancePx)
    {
        TimeSeconds = timeSeconds;
        NormX = normX;
        NormY = normY;
        ViewportPxX = viewportPxX;
        ViewportPxY = viewportPxY;
        VelXPxPerSec = velXPxPerSec;
        VelYPxPerSec = velYPxPerSec;
        Direction = direction;
        CumulativeDistancePx = cumulativeDistancePx;
    }

    public double TimeSeconds { get; }

    /// <summary>人物局部归一化 X。</summary>
    public double NormX { get; }

    /// <summary>人物局部归一化 Y。</summary>
    public double NormY { get; }

    /// <summary>视口物理像素 X（DPI 已换算）。</summary>
    public double ViewportPxX { get; }

    /// <summary>视口物理像素 Y。</summary>
    public double ViewportPxY { get; }

    /// <summary>水平速度（物理像素/秒）。</summary>
    public double VelXPxPerSec { get; }

    /// <summary>垂直速度（物理像素/秒）。</summary>
    public double VelYPxPerSec { get; }

    /// <summary>当前方向：-1=左 0=停 1=右。</summary>
    public int Direction { get; }

    /// <summary>累计移动距离（物理像素）。</summary>
    public double CumulativeDistancePx { get; }
}
