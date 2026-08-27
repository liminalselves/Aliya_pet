/// 结束抚摸会话的原因（所有结束路径统一走 endPettingSession）。
enum PettingEndReason {
  /// 用户松开鼠标（自然结束）。
  mouseReleased,

  /// 指针移出角色有效区域。
  pointerLeftCharacter,

  /// 指针移出容差区域。
  pointerOutsideTolerance,

  /// 鼠标捕获丢失。
  lostCapture,

  /// 窗口失活 / Alt+Tab。
  windowDeactivated,

  /// 切换 PNG/Live2D 模式。
  modeChanged,

  /// 按了 Esc。
  escapePressed,

  /// 切换角色。
  characterChanged,

  /// 退出应用 / 关闭窗口。
  windowClosing,

  /// Native 渲染失败或模型重载。
  nativeError,

  /// 安全兜底（自动松开 / 状态丢失 / 超过最大允许时间）。
  safetyTimeout,
}
