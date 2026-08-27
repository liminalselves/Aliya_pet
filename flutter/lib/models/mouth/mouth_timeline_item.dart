import 'mouth_shape.dart';

/// 嘴部时间线中的一个条目（口型）。
class MouthTimelineItem {
  const MouthTimelineItem(
    this.startMilliseconds,
    this.durationMilliseconds,
    this.shape, {
    this.isPause = false,
  });

  /// 相对会话开始的时间（毫秒）。
  final int startMilliseconds;

  /// 该口型持续时长（毫秒）。
  final int durationMilliseconds;

  final MouthShape shape;

  /// 是否为停顿（闭嘴的标点/换页停顿）。
  final bool isPause;

  int get endMilliseconds => startMilliseconds + durationMilliseconds;
}
