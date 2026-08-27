import 'time_scene_service.dart';

/// 动态变量解析。
/// Aliya 与玩家所在时间始终相差 1000 年：
///   {player_year}  玩家电脑当前本地年份
///   {aliya_year}   player_year + 1000
///   {current_month} 当前月份
///   {current_day}   当前日
///   {current_time}  当前时间 HH:mm
///   {time_period}   当前时间段中文标签
/// 年份禁止写死在业务代码中，一律由本地时间计算。
class DialogueVariableService {
  DialogueVariableService(this._timeSceneService);

  final TimeSceneService _timeSceneService;

  static final RegExp _variablePattern = RegExp(r'\{[a-zA-Z_]+\}');

  /// 解析动态变量，返回替换后的最终文本。未识别的变量记录一次日志。
  String resolve(String text, DateTime now) {
    if (text.isEmpty) return text;

    final playerYear = now.year;
    final aliyaYear = playerYear + 1000;
    final periodLabel = _timeSceneService.getPeriodLabel(now);

    var result = text
        .replaceAll('{player_year}', '$playerYear')
        .replaceAll('{aliya_year}', '$aliyaYear')
        .replaceAll('{current_month}', now.month.toString().padLeft(2, '0'))
        .replaceAll('{current_day}', now.day.toString().padLeft(2, '0'))
        .replaceAll('{current_time}', _hhmm(now))
        .replaceAll('{time_period}', periodLabel);

    for (final match in _variablePattern.allMatches(result)) {
      // 未识别的变量
      result = result.replaceAll(match.group(0)!, '');
    }
    return result;
  }

  static String _hhmm(DateTime now) =>
      '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
}
