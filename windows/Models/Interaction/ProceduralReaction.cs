namespace AliyaPet.Models.Interaction;

/// <summary>程序化互动反应（点击 head/face/ear、快速拖动等）。</summary>
public sealed class ProceduralReaction
{
    /// <summary>反应类型。</summary>
    public ProceduralReactionType Type { get; init; }

    /// <summary>强度 0..1。</summary>
    public double Strength { get; init; } = 0.5;

    /// <summary>相关区域 ID（可选）。</summary>
    public string? AreaId { get; init; }

    public static ProceduralReaction EyesAndTilt(double strength) => new()
    {
        Type = ProceduralReactionType.HeadTiltAndEyes,
        Strength = strength
    };

    public static ProceduralReaction HeadTiltAndEyes(double strength) => EyesAndTilt(strength);

    public static ProceduralReaction LookAtThenAway(double strength) => new()
    {
        Type = ProceduralReactionType.LookAtThenAway,
        Strength = strength
    };

    public static ProceduralReaction EarTwitch(double strength, string areaId) => new()
    {
        Type = ProceduralReactionType.EarTwitch,
        Strength = strength,
        AreaId = areaId
    };

    public static ProceduralReaction EyesWiden(double strength) => new()
    {
        Type = ProceduralReactionType.EyesWiden,
        Strength = strength
    };

    public static ProceduralReaction Doubt(double strength) => new()
    {
        Type = ProceduralReactionType.Doubt,
        Strength = strength
    };
}

public enum ProceduralReactionType
{
    None,
    /// <summary>轻微闭眼 + 头部小幅倾斜。</summary>
    HeadTiltAndEyes,
    /// <summary>短暂看向鼠标后移开。</summary>
    LookAtThenAway,
    /// <summary>对应耳朵小幅反应。</summary>
    EarTwitch,
    /// <summary>眼睛短暂睁大。</summary>
    EyesWiden,
    /// <summary>疑惑反应。</summary>
    Doubt
}
