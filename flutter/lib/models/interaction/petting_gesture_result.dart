/// 抚摸手势识别结果。
class PettingGestureResult {
  const PettingGestureResult({
    this.isValid = false,
    this.directionReversed = false,
    this.direction = 0,
    this.smoothedVelXPxPerSec = 0,
    this.startDistancePx = 0,
    this.strokeDistancePx = 0,
  });

  static const PettingGestureResult invalid =
      PettingGestureResult();

  /// 手势是否有效（有水平移动 + 起始距离足够 + 速度在范围内）。
  final bool isValid;

  /// 是否出现有效方向的翻转（方向 +1 到 -1 或反之）。
  final bool directionReversed;

  /// 当前方向 -1 左 / 1 右。
  final int direction;

  /// 平滑后的水平速度（像素/秒，负为左）。
  final double smoothedVelXPxPerSec;

  /// 起始移动距离（累计基准）。
  final double startDistancePx;

  /// 累计有效移动距离（累计基准）。
  final double strokeDistancePx;
}
