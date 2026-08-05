using System;
using System.Text;
using System.Text.RegularExpressions;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 动态变量解析。
/// Aliya 与玩家所在时间始终相差 1000 年：
///   {player_year}  玩家电脑当前本地年份
///   {aliya_year}   player_year + 1000
///   {current_month} 当前月份
///   {current_day}   当前日
///   {current_time}  当前时间 HH:mm
///   {time_period}   当前时间段中文标签
/// 年份禁止写死在业务代码中，一律由本地时间计算。
/// </summary>
public sealed class DialogueVariableService
{
    private static readonly Regex VariablePattern = new(@"\{[a-zA-Z_]+\}", RegexOptions.Compiled);

    private readonly TimeSceneService _timeSceneService;

    public DialogueVariableService(TimeSceneService timeSceneService)
    {
        _timeSceneService = timeSceneService;
    }

    /// <summary>解析动态变量，返回替换后的最终文本。未识别的变量记录一次日志。</summary>
    public string Resolve(string text, DateTime now)
    {
        if (string.IsNullOrEmpty(text))
            return text;

        var playerYear = now.Year;
        var aliyaYear = playerYear + 1000;
        var periodLabel = _timeSceneService.GetPeriodLabel(now);

        var result = new StringBuilder(text);
        result.Replace("{player_year}", playerYear.ToString(System.Globalization.CultureInfo.InvariantCulture));
        result.Replace("{aliya_year}", aliyaYear.ToString(System.Globalization.CultureInfo.InvariantCulture));
        result.Replace("{current_month}", now.Month.ToString("D2"));
        result.Replace("{current_day}", now.Day.ToString("D2"));
        result.Replace("{current_time}", now.ToString("HH:mm"));
        result.Replace("{time_period}", periodLabel);

        foreach (Match match in VariablePattern.Matches(result.ToString()))
            AppLog.Warn("DIALOGUE_UNKNOWN_VARIABLE name={0}", match.Value);

        return result.ToString();
    }
}
