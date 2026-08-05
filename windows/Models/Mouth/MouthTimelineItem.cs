namespace AliyaPet.Models.Mouth;

/// <summary>嘴型时间轴中的一个目标姿态。</summary>
public sealed class MouthTimelineItem
{
    public MouthTimelineItem(int startMs, int durationMs, MouthShape shape, bool isPause = false)
    {
        StartMilliseconds = startMs;
        DurationMilliseconds = durationMs;
        Shape = shape;
        IsPause = isPause;
    }

    /// <summary>相对会话开始的时间（毫秒）。</summary>
    public int StartMilliseconds { get; }

    /// <summary>本姿态持续时长（毫秒）。</summary>
    public int DurationMilliseconds { get; }

    public MouthShape Shape { get; }

    /// <summary>是否为停顿（嘴巴闭合的标点/分页停顿）。</summary>
    public bool IsPause { get; }

    public int EndMilliseconds => StartMilliseconds + DurationMilliseconds;
}
