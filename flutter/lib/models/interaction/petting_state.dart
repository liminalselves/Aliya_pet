/// 抚摸模式状态机。
enum PettingState {
  /// 未进入抚摸模式。
  inactive,

  /// 已点击抚摸按钮，等待指针进入抚摸区域。
  armed,

  /// 指针位于 head_pet_zone 内。
  hoveringHead,

  /// 已按下（未开始有效移动）。
  pressed,

  /// 检测到有效抚摸移动，正在抚摸。
  petting,

  /// 松开后（指针还未离开）。
  finishing,
}
