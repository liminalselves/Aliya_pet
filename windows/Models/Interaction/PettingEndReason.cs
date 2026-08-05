namespace AliyaPet.Models.Interaction;

/// <summary>抚摸会话结束原因（所有结束路径必须走统一 EndPettingSession）。</summary>
public enum PettingEndReason
{
    /// <summary>用户松开左键（自然结束）。</summary>
    MouseReleased,
    /// <summary>指针移出人物有效区域。</summary>
    PointerLeftCharacter,
    /// <summary>指针移出头部容错区域。</summary>
    PointerOutsideTolerance,
    /// <summary>鼠标捕获丢失。</summary>
    LostCapture,
    /// <summary>窗口失焦 / Alt+Tab。</summary>
    WindowDeactivated,
    /// <summary>切换 PNG/Live2D 模式。</summary>
    ModeChanged,
    /// <summary>按 Esc。</summary>
    EscapePressed,
    /// <summary>切换角色。</summary>
    CharacterChanged,
    /// <summary>隐藏人物 / 关闭窗口。</summary>
    WindowClosing,
    /// <summary>Native 调用失败或模型重载。</summary>
    NativeError,
    /// <summary>安全兜底：左键已松开 / 捕获丢失 / 无手势样本超时。</summary>
    SafetyTimeout
}
