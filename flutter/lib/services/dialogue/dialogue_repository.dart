import 'dart:io';

import '../../models/dialogue/dialogue_entry.dart';
import '../../models/dialogue/dialogue_file.dart';

/// 台词仓库：从 dialogue 根目录递归加载全部 JSON。
/// 单个 JSON 损坏时记录日志并跳过；单个文件失败不影响其它文件；
/// 加载失败时保留少量内置安全回退台词。
class DialogueRepository {
  /// 点击/时间问候在内置 JSON 全部缺失时的安全回退台词（仅兜底）。
  static const Map<String, List<String>> fallbackByScene = {
    'user_click': [
      '在忙吗？我在这里等你。',
      '今天也一起加油吧。',
      '点击我会做随机动作哦。',
      '桌面宠物已连接。',
    ],
    'morning': ['早上好，新的一天也一起加油吧。'],
    'forenoon': ['上午好，忙碌时也记得喝点水。'],
    'lunch': ['到午饭时间了，先好好吃饭吧。'],
    'afternoon': ['下午好，累了就休息几分钟。'],
    'dinner': ['晚饭时间到了，别忙到忘记吃饭。'],
    'evening': ['晚上好，今天也辛苦了。'],
    'late_night': ['已经很晚了，早点休息吧。'],
    'deep_night': ['夜深了，先放下工作好好睡一觉吧。'],
  };

  final List<DialogueFile> _files = [];

  /// 全部已加载台词条目（enabled 与否都在内，抽取时再过滤）。
  List<DialogueEntry> allEntries = [];

  /// 全部有效（enabled=true 且有文本）条目。
  List<DialogueEntry> enabledEntries = [];

  /// 成功加载的 JSON 文件数。
  int loadedFileCount = 0;

  /// 损坏/解析失败的文件名列表。
  List<String> failedFiles = [];

  /// 台词总数。
  int get totalEntryCount => allEntries.length;

  /// 相对 dialogue 根目录递归扫描并加载全部 JSON。
  void loadFromDirectory(String rootDirectory) {
    _files.clear();
    final failed = <String>[];
    final all = <DialogueEntry>[];

    List<String> jsonFiles;
    try {
      final dir = Directory(rootDirectory);
      if (!dir.existsSync()) {
        jsonFiles = [];
      } else {
        jsonFiles = dir
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.json'))
            .map((f) => f.path)
            .toList();
      }
    } catch (_) {
      jsonFiles = [];
    }

    for (final file in jsonFiles) {
      try {
        final dialogue = DialogueFile.fromJsonString(
          File(file).readAsStringSync(),
          sourceFile: _makeRelative(rootDirectory, file),
        );
        _files.add(dialogue);
        if (dialogue.entries != null && dialogue.entries!.isNotEmpty) {
          all.addAll(dialogue.entries!);
        }
      } catch (_) {
        failed.add(file.split(Platform.pathSeparator).last);
      }
    }

    loadedFileCount = _files.length;
    failedFiles = failed;
    allEntries = all;
    enabledEntries = all
        .where((e) => e.enabled != false && (e.text?.trim().isNotEmpty ?? false))
        .toList();
  }

  /// 按场景取文件；场景名以实际 JSON 的 scene 字段为准。
  DialogueFile? findScene(String scene) {
    for (final f in _files) {
      if (f.scene == scene) return f;
    }
    return null;
  }

  /// 取某个场景的有效条目；无文件或无有效条目时返回空。
  List<DialogueEntry> getEnabledEntriesForScene(String scene) {
    final file = findScene(scene);
    if (file?.entries == null) return [];
    return file!.entries!
        .where((e) => e.enabled != false && (e.text?.trim().isNotEmpty ?? false))
        .toList();
  }

  /// 内置安全回退台词（仅当某场景完全无可用 JSON 条目时使用）。
  List<String> getFallbackForScene(String scene) =>
      fallbackByScene[scene] ?? const [];

  static String _makeRelative(String root, String fullPath) {
    var rootFull = File(root).absolute.path;
    var full = File(fullPath).absolute.path;
    if (full.startsWith(rootFull)) {
      return full.substring(rootFull.length).replaceFirst(RegExp(r'^[\\/]'), '');
    }
    return full.split(Platform.pathSeparator).last;
  }
}
