using System;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 时间场景：根据本地时间选择对应时间台词场景。
/// 实际场景名以 windows/Assets/dialogue/time/*.json 的 scene 字段为准。
/// </summary>
public sealed class TimeSceneService
{
    public const string Morning = "morning";       // 05:00 ~ 07:59 早晨
    public const string Forenoon = "forenoon";     // 08:00 ~ 10:59 上午
    public const string Lunch = "lunch";           // 11:00 ~ 13:59 午间
    public const string Afternoon = "afternoon";   // 14:00 ~ 16:59 下午
    public const string Dinner = "dinner";         // 17:00 ~ 18:59 晚餐
    public const string Evening = "evening";       // 19:00 ~ 21:59 傍晚/夜间
    public const string LateNight = "late_night";  // 22:00 ~ 23:59 深夜前段
    public const string DeepNight = "deep_night";  // 00:00 ~ 04:59 深夜

    /// <summary>按本地时间返回场景名。时间段映射：
    /// 05:00~07:59 早晨 / 08:00~10:59 上午 / 11:00~13:59 午间 /
    /// 14:00~16:59 下午 / 17:00~18:59 晚餐 / 19:00~21:59 傍晚 /
    /// 22:00~23:59 深夜前段 / 00:00~04:59 深夜。</summary>
    public string GetScene(DateTime time)
    {
        var minutes = time.Hour * 60 + time.Minute;
        if (minutes is >= 300 and <= 479) return Morning;
        if (minutes is >= 480 and <= 659) return Forenoon;
        if (minutes is >= 660 and <= 839) return Lunch;
        if (minutes is >= 840 and <= 1019) return Afternoon;
        if (minutes is >= 1020 and <= 1139) return Dinner;
        if (minutes is >= 1140 and <= 1319) return Evening;
        return minutes >= 1320 ? LateNight : DeepNight;
    }

    /// <summary>场景对应的中文时间段标签（用于 {time_period} 变量）。</summary>
    public string GetPeriodLabel(DateTime time)
    {
        return GetScene(time) switch
        {
            Morning => "早晨",
            Forenoon => "上午",
            Lunch => "午间",
            Afternoon => "下午",
            Dinner => "晚餐",
            Evening => "傍晚",
            LateNight => "深夜",
            _ => "深夜"
        };
    }
}
