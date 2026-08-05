namespace AliyaPet.Models.Mouth;

/// <summary>一个嘴型姿态：嘴开幅度（0..1 归一化）与嘴型（-1..1，模型无此参数时忽略）。</summary>
public readonly struct MouthShape
{
    public MouthShape(double openY, double form)
    {
        OpenY = openY;
        Form = form;
    }

    /// <summary>嘴开幅度，0=闭嘴，1=最大张开（写入前按模型真实范围映射）。</summary>
    public double OpenY { get; }

    /// <summary>嘴型形变，-1..1（仅模型存在 ParamMouthForm 时写入）。</summary>
    public double Form { get; }

    public static MouthShape Closed { get; } = new(0, 0);
}
