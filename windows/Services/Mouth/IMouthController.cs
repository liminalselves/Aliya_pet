using AliyaPet.Models.Mouth;

namespace AliyaPet.Services.Mouth;

/// <summary>嘴型写入通道。Live2D 模式可用；PNG 模式或无嘴部参数时不可用但不抛错。</summary>
public interface IMouthController
{
    /// <summary>嘴型通道是否可用（Live2D 就绪且模型存在嘴部参数）。</summary>
    bool IsAvailable { get; }

    /// <summary>写入当前帧嘴型（每帧由 MouthAnimationRunner 调用）。</summary>
    void Write(MouthAnimationFrame frame);

    /// <summary>释放嘴型通道（关闭覆盖，嘴巴回到闭合状态）。</summary>
    void Release();
}
