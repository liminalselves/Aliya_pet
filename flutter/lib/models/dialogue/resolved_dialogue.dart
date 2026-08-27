import '../mouth/mouth_timeline.dart';
import 'dialogue_entry.dart';
import 'dialogue_page.dart';

/// 一条台词会话的解析结果。
/// 同一 DialogueEntry -> 变量替换后的最终文本 -> 按分页 -> 嘴部时间线。
/// 若显示侧暂不需要嘴部时间线，可使用同一解析文本。
class ResolvedDialogue {
  const ResolvedDialogue({
    required this.entry,
    this.finalText = '',
    this.pages = const [],
    this.mouthTimeline,
    this.pageStartMilliseconds = const [],
    this.mouthTotalMilliseconds = 0,
  });

  final DialogueEntry entry;

  /// 变量替换后的最终文本（分页与嘴部时间线都基于它）。
  /// 可能含人工分页符 \（显示时去页符，时间线将其作为停顿）。
  final String finalText;

  final List<DialoguePage> pages;

  /// 基于最终文本的嘴部时间线（为空表示无需嘴部动画）。
  final MouthTimeline? mouthTimeline;

  /// 每页（含第一页）对应的嘴部开始时间（毫秒），翻页时以此对齐。
  final List<int> pageStartMilliseconds;

  /// 嘴部时间线总时长（毫秒）。
  final int mouthTotalMilliseconds;
}
