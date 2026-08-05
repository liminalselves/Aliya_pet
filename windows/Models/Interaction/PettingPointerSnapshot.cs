using System.Windows;

namespace AliyaPet.Models.Interaction;

/// <summary>
/// 抚摸输入最新指针快照（struct，避免堆分配）。
/// MouseMove 热路径只负责记录最新一次输入，渲染/消费循环每帧最多消费一次。
/// </summary>
public readonly struct PettingPointerSnapshot
{
    public PettingPointerSnapshot(
        Point position,
        long timestamp,
        bool isLeftButtonPressed,
        bool isInsideToleranceZone,
        long sequence)
    {
        Position = position;
        Timestamp = timestamp;
        IsLeftButtonPressed = isLeftButtonPressed;
        IsInsideToleranceZone = isInsideToleranceZone;
        Sequence = sequence;
    }

    /// <summary>窗口 DIP 坐标（主窗口坐标系）。</summary>
    public Point Position { get; }

    /// <summary>Stopwatch.GetTimestamp 时间戳。</summary>
    public long Timestamp { get; }

    /// <summary>左键是否按下。</summary>
    public bool IsLeftButtonPressed { get; }

    /// <summary>是否位于抚摸容错区（预计算缓存矩形 Contains，O(1)）。</summary>
    public bool IsInsideToleranceZone { get; }

    /// <summary>输入序号（单调递增，用于"只保留最新、丢弃过期"）。</summary>
    public long Sequence { get; }
}
