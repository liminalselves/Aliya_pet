using System;
using System.Collections.Generic;

namespace AliyaPet.Models.Interaction;

/// <summary>
/// 当日互动状态（仅用于防重复台词 / petting_repeat 权重 / 当日互动次数）。
/// 不保存完整鼠标轨迹；跨天后当日计数自动清零。
/// </summary>
public sealed class InteractionState
{
    private DateTime _lastDay = DateTime.Now.Date;

    /// <summary>当日抚摸次数。</summary>
    public int HeadPettingCountToday { get; private set; }

    /// <summary>当日抚摸累计时长（毫秒）。</summary>
    public long HeadPettingDurationTodayMs { get; private set; }

    /// <summary>最近一次抚摸开始时间（本地）。</summary>
    public DateTime? LastHeadPettingTime { get; private set; }

    /// <summary>单次抚摸最长时长（毫秒）。</summary>
    public long LongestPettingDurationMs { get; private set; }

    /// <summary>最近使用的抚摸台词 ID（防重复）。</summary>
    public List<string> LastPettingDialogueIds { get; } = new();

    private const int RecentDialogueIdMax = 4;

    public void EnsureDayFresh()
    {
        var today = DateTime.Now.Date;
        if (today != _lastDay)
        {
            _lastDay = today;
            HeadPettingCountToday = 0;
            HeadPettingDurationTodayMs = 0;
            LastHeadPettingTime = null;
            LongestPettingDurationMs = 0;
            LastPettingDialogueIds.Clear();
        }
    }

    /// <summary>记录一次抚摸开始。</summary>
    public void BeginPetting(DateTime time)
    {
        EnsureDayFresh();
        LastHeadPettingTime = time;
    }

    /// <summary>记录一次抚摸结束并累计当日时长。</summary>
    public void EndPetting(long durationMs)
    {
        EnsureDayFresh();
        HeadPettingCountToday++;
        HeadPettingDurationTodayMs += Math.Max(0, durationMs);
        if (durationMs > LongestPettingDurationMs)
            LongestPettingDurationMs = durationMs;
    }

    public void RecordDialogueId(string id)
    {
        if (string.IsNullOrEmpty(id))
            return;
        LastPettingDialogueIds.Remove(id);
        LastPettingDialogueIds.Insert(0, id);
        if (LastPettingDialogueIds.Count > RecentDialogueIdMax)
            LastPettingDialogueIds.RemoveRange(RecentDialogueIdMax, LastPettingDialogueIds.Count - RecentDialogueIdMax);
    }

    public bool WasRecentlyUsed(string id) => LastPettingDialogueIds.Contains(id);
}
