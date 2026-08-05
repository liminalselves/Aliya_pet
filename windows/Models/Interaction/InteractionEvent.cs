namespace AliyaPet.Models.Interaction;

/// <summary>互动输入事件类型（MainWindow 仅转发鼠标输入）。</summary>
public enum InteractionEvent
{
    PointerEnter,
    PointerMove,
    PointerDown,
    PointerUp,
    PointerLeave,
    Click,
    Esc,
    WindowClosed
}
