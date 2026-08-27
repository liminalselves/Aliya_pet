import 'dart:math' as math;

/// 快速拖动反应：眼睛短暂睁大 + 头部受限惯性 + 每次拖动最多一次台词。
class DragReactionService {
  static const double _fastDragSpeedThreshold = 250; // 物理像素/秒

  bool _dragging = false;
  double _maxSpeedPxPerSec = 0;

  bool get isDragging => _dragging;

  void beginDrag() {
    _dragging = true;
    _maxSpeedPxPerSec = 0;
  }

  void onDragMove(double speedPxPerSec) {
    if (!_dragging) return;
    if (speedPxPerSec.isFinite) {
      _maxSpeedPxPerSec = math.max(_maxSpeedPxPerSec, speedPxPerSec.abs());
    }
  }

  /// 结束拖动。返回本轮是否达到快速拖动阈值。
  ///
  /// M2 修复：原返回二元组的第二元素因每轮 beginDrag 重置而恒为 false，
  /// 且调用方已丢弃，故简化为单一返回值。
  bool endDrag() {
    if (!_dragging) return false;
    _dragging = false;
    return _maxSpeedPxPerSec >= _fastDragSpeedThreshold;
  }
}
