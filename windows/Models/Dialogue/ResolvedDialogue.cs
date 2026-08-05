using System.Collections.Generic;
using AliyaPet.Models.Mouth;

namespace AliyaPet.Models.Dialogue;

/// <summary>
/// 一次完整台词会话的解析结果：
/// 同一 DialogueEntry -> 变量替换后的最终文本 -> 气泡分页 -> 嘴型时间轴。
/// 气泡显示与嘴型时间轴必须使用同一份最终文本。
/// </summary>
public sealed class ResolvedDialogue
{
    public DialogueEntry Entry { get; init; } = null!;

    /// <summary>
    /// 变量替换后的最终文本（气泡分页与嘴型时间轴都基于它；
    /// 可能含人工分页符 \，显示时分页去除，时间轴将其视为停顿）。
    /// </summary>
    public string FinalText { get; init; } = "";

    public IReadOnlyList<DialoguePage> Pages { get; init; } =
        new List<DialoguePage>();

    /// <summary>由最终文本构建的嘴型时间轴（可为空，表示无嘴型能力时跳过）。</summary>
    public MouthTimeline? MouthTimeline { get; init; }

    /// <summary>每个气泡页对应的嘴型开始时间（毫秒），翻页时依据。</summary>
    public IReadOnlyList<int> PageStartMilliseconds { get; init; } =
        new List<int>();

    /// <summary>嘴型时间轴总时长（毫秒）。</summary>
    public int MouthTotalMilliseconds { get; init; }
}
