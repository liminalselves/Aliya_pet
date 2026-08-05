namespace AliyaPet.Models.Mouth;

/// <summary>嘴型播放器每帧计算出的写入值（已含时间平滑与随机变化）。</summary>
public readonly struct MouthAnimationFrame
{
    public MouthAnimationFrame(double openY, double form)
    {
        OpenY = openY;
        Form = form;
    }

    /// <summary>归一化嘴开幅度 0..1。</summary>
    public double OpenY { get; }

    /// <summary>归一化嘴型 -1..1。</summary>
    public double Form { get; }

    public static MouthAnimationFrame Closed { get; } = new(0, 0);
}
