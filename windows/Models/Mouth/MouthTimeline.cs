using System.Collections.Generic;
using System.Linq;

namespace AliyaPet.Models.Mouth;

/// <summary>完整嘴型时间轴。</summary>
public sealed class MouthTimeline
{
    public MouthTimeline(IReadOnlyList<MouthTimelineItem> items)
    {
        Items = items;
        TotalMilliseconds = items.Count == 0 ? 0 : items.Max(i => i.EndMilliseconds);
    }

    public IReadOnlyList<MouthTimelineItem> Items { get; }

    /// <summary>总时长（毫秒）。</summary>
    public int TotalMilliseconds { get; }
}
