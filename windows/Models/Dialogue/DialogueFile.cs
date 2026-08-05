using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AliyaPet.Models.Dialogue;

/// <summary>一个台词 JSON 文件（字段以实际 JSON 为准）。</summary>
public sealed class DialogueFile
{
    [JsonPropertyName("characterId")]
    public string? CharacterId { get; set; }

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("scene")]
    public string? Scene { get; set; }

    /// <summary>可选：抽取模式（如 shuffle_bag）。缺失时按普通随机。</summary>
    [JsonPropertyName("selectionMode")]
    public string? SelectionMode { get; set; }

    /// <summary>可选：单页最大字符数。缺失时使用默认值。</summary>
    [JsonPropertyName("singlePageMaxChars")]
    public int? SinglePageMaxChars { get; set; }

    /// <summary>可选：最大页数。缺失时使用默认值。</summary>
    [JsonPropertyName("maxPages")]
    public int? MaxPages { get; set; }

    [JsonPropertyName("entries")]
    public List<DialogueEntry>? Entries { get; set; }

    /// <summary>来源文件路径（相对 Assets/dialogue 根）。</summary>
    [JsonIgnore]
    public string? SourceFile { get; set; }
}
