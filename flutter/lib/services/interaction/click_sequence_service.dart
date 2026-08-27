import 'dart:math' as math;

/// 连续点击检测结果。
enum ClickResult {
  none,

  /// 3 秒内 3 次：疑惑反应。
  doubt,

  /// 4 秒内 5 次：轻微吐槽。
  comment,

  /// 6 秒内 8 次：进入点击冷却。
  cooldown,
}

/// 连续点击检测（3秒3次疑惑 / 4秒5次吐槽 / 6秒8次点击冷却）。
class ClickSequenceService {
  final List<DateTime> _clicks = [];
  DateTime _cooldownUntil = DateTime.fromMillisecondsSinceEpoch(0);
  final math.Random _random = math.Random();

  bool get isInCooldown => DateTime.now().toUtc().isBefore(_cooldownUntil);

  ClickResult registerClick() {
    final now = DateTime.now().toUtc();
    _clicks.add(now);
    while (_clicks.isNotEmpty && now.difference(_clicks.first).inSeconds > 6) {
      _clicks.removeAt(0);
    }

    if (isInCooldown) return ClickResult.cooldown;

    final within6 = _countWithin(now, 6);
    if (within6 >= 8) {
      _cooldownUntil = now.add(Duration(seconds: _random.nextInt(4) + 2));
      return ClickResult.cooldown;
    }

    if (_countWithin(now, 5) >= 4) return ClickResult.comment;
    if (_countWithin(now, 3) >= 3) return ClickResult.doubt;
    return ClickResult.none;
  }

  void reset() {
    _clicks.clear();
    _cooldownUntil = DateTime.fromMillisecondsSinceEpoch(0);
  }

  int _countWithin(DateTime now, int seconds) {
    var count = 0;
    for (var i = _clicks.length - 1; i >= 0; i--) {
      if (now.difference(_clicks[i]).inSeconds <= seconds) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}
