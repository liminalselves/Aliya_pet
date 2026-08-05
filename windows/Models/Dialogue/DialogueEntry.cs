using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AliyaPet.Models.Dialogue;

/// <summary>单个台词条目（字段以实际 JSON 为准，可选字段缺失不报错）。</summary>
public sealed class DialogueEntry
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("enabled")]
    public bool? Enabled { get; set; }

    [JsonPropertyName("weight")]
    public double? Weight { get; set; }

    [JsonPropertyName("minRepeatDays")]
    public int? MinRepeatDays { get; set; }

    [JsonPropertyName("tags")]
    public List<string>? Tags { get; set; }

    /// <summary>最近一次被抽取的本地日期（仅用于 minRepeatDays 约束）。</summary>
    [JsonIgnore]
    public DateTime? LastSelectedDate { get; set; }
}
