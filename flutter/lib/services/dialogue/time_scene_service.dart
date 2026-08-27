/// 时间场景：根据本地时间选择对应时间台词场景。
/// 实际场景名以 assets/dialogue/time/*.json 的 scene 字段为准。
class TimeSceneService {
  static const String morning = 'morning'; // 05:00 ~ 07:59 早晨
  static const String forenoon = 'forenoon'; // 08:00 ~ 10:59 上午
  static const String lunch = 'lunch'; // 11:00 ~ 13:59 午间
  static const String afternoon = 'afternoon'; // 14:00 ~ 16:59 下午
  static const String dinner = 'dinner'; // 17:00 ~ 18:59 晚餐
  static const String evening = 'evening'; // 19:00 ~ 21:59 傍晚/夜间
  static const String lateNight = 'late_night'; // 22:00 ~ 23:59 深夜前段
  static const String deepNight = 'deep_night'; // 00:00 ~ 04:59 深夜

  /// 按本地时间返回场景名。
  String getScene(DateTime time) {
    final minutes = time.hour * 60 + time.minute;
    if (minutes >= 300 && minutes <= 479) return morning;
    if (minutes >= 480 && minutes <= 659) return forenoon;
    if (minutes >= 660 && minutes <= 839) return lunch;
    if (minutes >= 840 && minutes <= 1019) return afternoon;
    if (minutes >= 1020 && minutes <= 1139) return dinner;
    if (minutes >= 1140 && minutes <= 1319) return evening;
    return minutes >= 1320 ? lateNight : deepNight;
  }

  /// 场景对应的中文时间段标签（用于 {time_period} 变量）。
  String getPeriodLabel(DateTime time) {
    switch (getScene(time)) {
      case morning:
        return '早晨';
      case forenoon:
        return '上午';
      case lunch:
        return '午间';
      case afternoon:
        return '下午';
      case dinner:
        return '晚餐';
      case evening:
        return '傍晚';
      case lateNight:
        return '深夜';
      default:
        return '深夜';
    }
  }
}
