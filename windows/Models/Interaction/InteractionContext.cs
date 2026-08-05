namespace AliyaPet.Models.Interaction;

/// <summary>一次互动输入上下文：人物渲染区域归一化坐标 + 视口物理像素坐标。</summary>
public readonly struct InteractionContext
{
    public InteractionContext(
        double normX, double normY,
        double viewportPxX, double viewportPxY,
        double deltaSeconds,
        bool leftPressed)
    {
        NormX = normX;
        NormY = normY;
        ViewportPxX = viewportPxX;
        ViewportPxY = viewportPxY;
        DeltaSeconds = deltaSeconds;
        LeftPressed = leftPressed;
    }

    /// <summary>人物渲染区域归一化 X（0..1，左为 0）。</summary>
    public double NormX { get; }

    /// <summary>人物渲染区域归一化 Y（0..1，上为 0）。</summary>
    public double NormY { get; }

    /// <summary>视口物理像素坐标（DPI 已换算）。</summary>
    public double ViewportPxX { get; }

    public double ViewportPxY { get; }

    /// <summary>距上一事件的秒数。</summary>
    public double DeltaSeconds { get; }

    public bool LeftPressed { get; }
}
