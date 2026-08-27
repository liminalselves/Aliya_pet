/// 指针快照（轻量 struct，无分配）。
/// 事件线程只写入最新快照，渲染/交互循环每帧只读取一次。
class PettingPointerSnapshot {
  const PettingPointerSnapshot({
    required this.positionX,
    required this.positionY,
    required this.timestamp,
    required this.isLeftButtonPressed,
    required this.isInsideToleranceZone,
    required this.sequence,
  });

  /// 位置 X（DIP 坐标，相对渲染区域）。
  final double positionX;

  /// 位置 Y（DIP 坐标，相对渲染区域）。
  final double positionY;

  /// 时间戳（微秒）。
  final int timestamp;

  /// 左键是否按下。
  final bool isLeftButtonPressed;

  /// 是否位于抚摸容差预计算缓冲区内（O(1)）。
  final bool isInsideToleranceZone;

  /// 序号（用于事件端"只处理更新的输入"）。
  final int sequence;
}
