/// 一次交互更新的输入快照（渲染器/交互循环每帧消费一次 + 窗口坐标）。
class InteractionContext {
  const InteractionContext({
    required this.normX,
    required this.normY,
    required this.viewportPxX,
    required this.viewportPxY,
    required this.deltaSeconds,
    required this.leftPressed,
    this.isSecondaryButton = false,
  });

  /// 相对渲染区域归一化 X（0..1，向下为 0）。
  final double normX;

  /// 相对渲染区域归一化 Y（0..1，向下为 0）。
  final double normY;

  /// 视口像素坐标 X（DPI 已换算）。
  final double viewportPxX;

  /// 视口像素坐标 Y。
  final double viewportPxY;

  /// 距上一帧事件的时间（秒）。
  final double deltaSeconds;

  /// 左键是否按下。
  final bool leftPressed;

  /// 是否为右键（辅助键）事件。触摸/触屏为 false。
  final bool isSecondaryButton;
}
