import 'mouth_timeline_item.dart';

/// 嘴部动画时间线。
class MouthTimeline {
  MouthTimeline(List<MouthTimelineItem> items)
      : items = List.unmodifiable(items) {
    totalMilliseconds = items.isEmpty
        ? 0
        : items.map((i) => i.endMilliseconds).reduce((a, b) => a > b ? a : b);
  }

  final List<MouthTimelineItem> items;

  /// 总时长（毫秒）。
  late final int totalMilliseconds;

  /// 查询 t 毫秒时刻的口型；无匹配返回 null。
  MouthTimelineItem? itemAt(int tMs) {
    for (final item in items) {
      if (tMs >= item.startMilliseconds && tMs < item.endMilliseconds) {
        return item;
      }
    }
    return null;
  }
}
