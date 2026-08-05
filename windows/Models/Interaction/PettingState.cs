namespace AliyaPet.Models.Interaction;

/// <summary>抚摸模式状态机。</summary>
public enum PettingState
{
    /// <summary>未进入抚摸模式。</summary>
    Inactive,
    /// <summary>已点击手掌按钮，等待指针进入抚摸区域。</summary>
    Armed,
    /// <summary>指针位于 head_pet_zone 内。</summary>
    HoveringHead,
    /// <summary>左键已按下。</summary>
    Pressed,
    /// <summary>检测到有效左右移动，正在抚摸。</summary>
    Petting,
    /// <summary>松开左键，恢复参数。</summary>
    Finishing
}
