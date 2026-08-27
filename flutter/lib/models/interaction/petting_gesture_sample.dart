/// 一次抚摸轨迹采样（固定窗口的滑动样本，只保留最近约 1 秒）。
class PettingGestureSample {
  const PettingGestureSample({
    required this.timeSeconds,
    required this.normX,
    required this.normY,
    required this.viewportPxX,
    required this.viewportPxY,
    required this.velXPxPerSec,
    required this.velYPxPerSec,
    required this.direction,
    required this.cumulativeDistancePx,
  });

  final double timeSeconds;

  /// 归一化 X（相对渲染区域）。
  final double normX;

  /// 归一化 Y。
  final double normY;

  /// 视口像素 X（DPI 已换算）。
  final double viewportPxX;

  /// 视口像素 Y。
  final double viewportPxY;

  /// 水平速度（像素/秒）。
  final double velXPxPerSec;

  /// 垂直速度（像素/秒）。
  final double velYPxPerSec;

  /// 当前方向 -1=左 0=停 1=右。
  final int direction;

  /// 累计移动距离（累计基准）。
  final double cumulativeDistancePx;
}
