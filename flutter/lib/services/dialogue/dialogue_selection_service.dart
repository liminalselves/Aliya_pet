import 'dart:math' as math;

import '../../models/dialogue/dialogue_entry.dart';
import 'dialogue_repository.dart';

/// 台词抽取：
///   - enabled=false 永不抽取
///   - selectionMode=shuffle_bag：洗牌袋，同一轮内不重复，新一轮重新洗牌
///   - 存在 weight：加权抽取（一轮内加权不重复）
///   - 存在 minRepeatDays：最短重复天数内不重复
///   - 场景无有效条目时使用内置安全回退台词
class DialogueSelectionService {
  DialogueSelectionService(this._repository, {math.Random? random})
      : _random = random ?? math.Random();

  static const String shuffleBagMode = 'shuffle_bag';

  final DialogueRepository _repository;
  final math.Random _random;

  final Map<String, List<DialogueEntry>> _bags = {};
  final Map<String, List<DialogueEntry>> _tagBags = {};

  /// 按场景抽取一条台词。
  DialogueEntry select(String scene) {
    final entries = _repository.getEnabledEntriesForScene(scene);
    final now = DateTime.now();

    final candidates =
        entries.where((e) => e.enabled != false).toList();

    if (candidates.isEmpty) {
      final fallback = _repository.getFallbackForScene(scene);
      if (fallback.isEmpty) {
        return DialogueEntry(id: 'fallback', text: '今天也一起加油吧。', enabled: true);
      }
      final line = fallback[_random.nextInt(fallback.length)];
      return DialogueEntry(id: 'fallback_$scene', text: line, enabled: true);
    }

    // minRepeatDays 过滤：最近 N 天内已被抽取的条目本轮不参与
    var available = candidates
        .where((e) =>
            e.minRepeatDays == null ||
            e.minRepeatDays! <= 0 ||
            e.lastSelectedDate == null ||
            now.difference(e.lastSelectedDate!).inDays >= e.minRepeatDays!)
        .toList();
    if (available.isEmpty) {
      // 全部都在冷却中：放宽，优先选择冷却时间最长的
      available = [...candidates]
        ..sort((a, b) => (a.lastSelectedDate ?? DateTime(1970))
            .compareTo(b.lastSelectedDate ?? DateTime(1970)));
    }

    final DialogueEntry entry;
    final file = _repository.findScene(scene);
    if (file?.selectionMode?.toLowerCase() == shuffleBagMode) {
      entry = _selectFromBag(scene, available);
    } else {
      entry = _weightedPick(available);
    }

    entry.lastSelectedDate = now;
    return entry;
  }

  /// 从全部已加载的有效条目中随机抽取一条（随机说话用）。
  DialogueEntry selectRandom() {
    final enabled = _repository.enabledEntries;
    if (enabled.isEmpty) {
      return DialogueEntry(id: 'fallback', text: '今天也一起加油吧。', enabled: true);
    }
    final entry = _weightedPick(enabled);
    entry.lastSelectedDate = DateTime.now();
    return entry;
  }

  /// 按场景 + tag 抽取（抚摸台词等分组场景用）。同一 (scene:tag) 使用独立洗牌袋，
  /// 一轮内不重复；weightBoost 提高该组权重（用于 petting_repeat 随当日次数增强）。
  DialogueEntry? selectByTag(String scene, String tag,
      {Set<String>? excludeIds, double weightBoost = 0}) {
    var entries = _repository
        .getEnabledEntriesForScene(scene)
        .where((e) => e.tags != null && e.tags!.contains(tag))
        .toList();
    if (entries.isEmpty) {
      return null;
    }

    if (excludeIds != null && excludeIds.isNotEmpty) {
      final filtered =
          entries.where((e) => e.id == null || !excludeIds.contains(e.id)).toList();
      if (filtered.isNotEmpty) entries = filtered;
    }

    final now = DateTime.now();
    var available = entries
        .where((e) =>
            e.enabled != false &&
            (e.minRepeatDays == null ||
                e.minRepeatDays! <= 0 ||
                e.lastSelectedDate == null ||
                now.difference(e.lastSelectedDate!).inDays >= e.minRepeatDays!))
        .toList();
    if (available.isEmpty) available = entries;

    final bagKey = '$scene:$tag';
    var bag = _tagBags[bagKey];
    if (bag == null || bag.isEmpty) {
      bag = _buildBag(available, weightBoost);
      _tagBags[bagKey] = bag;
    }

    final entry = bag.removeAt(0);
    entry.lastSelectedDate = now;
    return entry;
  }

  DialogueEntry _selectFromBag(String scene, List<DialogueEntry> available) {
    var bag = _bags[scene];
    if (bag == null || bag.isEmpty) {
      bag = _buildBag(available);
      _bags[scene] = bag;
    }

    final entry = bag.removeAt(0);
    return entry;
  }

  List<DialogueEntry> _buildBag(List<DialogueEntry> available,
      [double weightBoost = 0]) {
    final hasWeight =
        available.any((e) => (e.weight ?? 0) > 0) || weightBoost > 0;
    if (!hasWeight) {
      final list = [...available];
      for (var i = list.length - 1; i > 0; i--) {
        final j = _random.nextInt(i + 1);
        final tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
      return list;
    }

    // 加权抽取不重复：每次从剩余中按权重抽取并移除，形成一轮
    double effectiveWeight(DialogueEntry e) =>
        math.max(0.01, (e.weight ?? 1.0) * (1.0 + weightBoost));

    final remaining = [...available];
    final result = <DialogueEntry>[];
    while (remaining.isNotEmpty) {
      var total = 0.0;
      for (final e in remaining) {
        total += effectiveWeight(e);
      }
      final roll = _random.nextDouble() * total;
      var acc = 0.0;
      var pick = remaining.length - 1;
      for (var i = 0; i < remaining.length; i++) {
        acc += effectiveWeight(remaining[i]);
        if (roll <= acc) {
          pick = i;
          break;
        }
      }
      result.add(remaining.removeAt(pick));
    }
    return result;
  }

  DialogueEntry _weightedPick(List<DialogueEntry> available) {
    final hasWeight = available.any((e) => (e.weight ?? 0) > 0);
    if (!hasWeight) {
      return available[_random.nextInt(available.length)];
    }

    var total = 0.0;
    for (final e in available) {
      total += math.max(0.01, e.weight ?? 1.0);
    }
    final roll = _random.nextDouble() * total;
    var acc = 0.0;
    for (final e in available) {
      acc += math.max(0.01, e.weight ?? 1.0);
      if (roll <= acc) return e;
    }
    return available.last;
  }
}
