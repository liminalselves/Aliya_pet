import 'dart:math' as math;

/// 每日交互状态（抚摸次数/时长/最近台词，跨天自动重置）。
class InteractionState {
  DateTime _lastDay = _today();

  /// 今天抚摸次数。
  int headPettingCountToday = 0;

  /// 今天抚摸累计时长（毫秒）。
  int headPettingDurationTodayMs = 0;

  /// 最近一次抚摸开始时间（本地时区）。
  DateTime? lastHeadPettingTime;

  /// 单次最长抚摸时长（毫秒）。
  int longestPettingDurationMs = 0;

  /// 最近使用的抚摸台词 ID（避免重复）。
  final List<String> lastPettingDialogueIds = [];

  static const int recentDialogueIdMax = 4;

  static DateTime _today() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }

  void ensureDayFresh() {
    final today = _today();
    if (today != _lastDay) {
      _lastDay = today;
      headPettingCountToday = 0;
      headPettingDurationTodayMs = 0;
      lastHeadPettingTime = null;
      longestPettingDurationMs = 0;
      lastPettingDialogueIds.clear();
    }
  }

  /// 记录一次抚摸开始。
  void beginPetting(DateTime time) {
    ensureDayFresh();
    lastHeadPettingTime = time;
  }

  /// 记录一次抚摸结束（累计当日时长）。
  void endPetting(int durationMs) {
    ensureDayFresh();
    headPettingCountToday++;
    headPettingDurationTodayMs += math.max(0, durationMs);
    if (durationMs > longestPettingDurationMs) {
      longestPettingDurationMs = durationMs;
    }
  }

  void recordDialogueId(String id) {
    if (id.isEmpty) return;
    lastPettingDialogueIds.remove(id);
    lastPettingDialogueIds.insert(0, id);
    if (lastPettingDialogueIds.length > recentDialogueIdMax) {
      lastPettingDialogueIds.removeRange(
          recentDialogueIdMax, lastPettingDialogueIds.length);
    }
  }

  bool wasRecentlyUsed(String id) => lastPettingDialogueIds.contains(id);
}
