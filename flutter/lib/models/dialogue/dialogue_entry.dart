import 'dart:convert';

/// 一条台词条目（字段以实际 JSON 为准，可选字段缺失时容错）。
class DialogueEntry {
  DialogueEntry({
    this.id,
    this.text,
    this.enabled,
    this.weight,
    this.minRepeatDays,
    this.tags,
    this.lastSelectedDate,
  });

  final String? id;
  final String? text;
  final bool? enabled;
  final double? weight;
  final int? minRepeatDays;
  final List<String>? tags;

  /// 最近一次被选取的日期（用于 minRepeatDays 约束，不序列化）。
  DateTime? lastSelectedDate;

  factory DialogueEntry.fromJson(Map<String, dynamic> json) => DialogueEntry(
        id: json['id'] as String?,
        text: json['text'] as String?,
        enabled: json['enabled'] as bool?,
        weight: (json['weight'] as num?)?.toDouble(),
        minRepeatDays: json['minRepeatDays'] as int?,
        tags: (json['tags'] as List<dynamic>?)?.cast<String>(),
      );

  static List<DialogueEntry> listFromJson(String raw) {
    final list = jsonDecode(raw) as List<dynamic>;
    return list
        .map((e) => DialogueEntry.fromJson(e as Map<String, dynamic>))
        .toList();
  }
}
