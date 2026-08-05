namespace AliyaPet.Models.Interaction;

/// <summary>互动区域定义（归一化坐标，相对人物渲染区域）。</summary>
public sealed class HitAreaDefinition
{
    /// <summary>区域 ID：head/face/ear_left/ear_right/hair/body/hand/tablet/head_pet_zone。</summary>
    public string Id { get; set; } = "";

    /// <summary>形状：ellipse / rect。</summary>
    public string Type { get; set; } = "ellipse";

    /// <summary>中心归一化 X（0..1）。</summary>
    public double X { get; set; } = 0.5;

    /// <summary>中心归一化 Y（0..1，上为 0）。</summary>
    public double Y { get; set; } = 0.5;

    /// <summary>归一化宽度（0..1）。</summary>
    public double Width { get; set; } = 0.3;

    /// <summary>归一化高度（0..1）。</summary>
    public double Height { get; set; } = 0.3;

    /// <summary>命中优先级（数值大优先）。</summary>
    public int Priority { get; set; }

    public bool Contains(double nx, double ny, bool mirrored)
    {
        double cx = mirrored ? 1.0 - X : X;
        double cy = Y;
        if (Type == "rect")
        {
            double halfW = Width / 2;
            double halfH = Height / 2;
            return nx >= cx - halfW && nx <= cx + halfW && ny >= cy - halfH && ny <= cy + halfH;
        }

        // 椭圆
        double dx = (nx - cx) / Math.Max(1e-6, Width / 2);
        double dy = (ny - cy) / Math.Max(1e-6, Height / 2);
        return dx * dx + dy * dy <= 1.0;
    }

    /// <summary>归一化包围盒（供调试覆盖层）。</summary>
    public (double left, double top, double width, double height) GetBounds(bool mirrored)
    {
        double cx = mirrored ? 1.0 - X : X;
        return (cx - Width / 2, Y - Height / 2, Width, Height);
    }
}
