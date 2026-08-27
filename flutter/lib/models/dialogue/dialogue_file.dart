import 'dart:convert';

import 'dialogue_entry.dart';

/// 一个台词 JSON 文件（字段以实际 JSON 为准）。
class DialogueFile {
  DialogueFile({
    this.characterId,
    this.category,
    this.scene,
    this.selectionMode,
    this.singlePageMaxChars,
    this.maxPages,
    this.entries,
    this.sourceFile,
  });

  final String? characterId;
  final String? category;
  final String? scene;

  /// 可选：选取模式（如 shuffle_bag），缺失时按普通随机。
  final String? selectionMode;

  /// 可选：单页最大字符数，缺失时用默认值。
  final int? singlePageMaxChars;

  /// 可选：最大页数，缺失时用默认值。
  final int? maxPages;

  final List<DialogueEntry>? entries;

  /// 源文件路径（相对 Assets/dialogue）。
  final String? sourceFile;

  factory DialogueFile.fromJson(Map<String, dynamic> json) => DialogueFile(
        characterId: json['characterId'] as String?,
        category: json['category'] as String?,
        scene: json['scene'] as String?,
        selectionMode: json['selectionMode'] as String?,
        singlePageMaxChars: json['singlePageMaxChars'] as int?,
        maxPages: json['maxPages'] as int?,
        entries: (json['entries'] as List<dynamic>?)
            ?.map((e) => DialogueEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  static DialogueFile fromJsonString(String raw, {String? sourceFile}) {
    final file = DialogueFile.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    return DialogueFile(
      characterId: file.characterId,
      category: file.category,
      scene: file.scene,
      selectionMode: file.selectionMode,
      singlePageMaxChars: file.singlePageMaxChars,
      maxPages: file.maxPages,
      entries: file.entries,
      sourceFile: sourceFile,
    );
  }
}
