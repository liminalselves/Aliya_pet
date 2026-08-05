using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using AliyaPet.Models.Dialogue;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 台词仓库：从 Assets/dialogue 递归加载全部 JSON。
/// 单个 JSON 损坏时记录日志并跳过；单个文件失败不影响其它文件；加载失败时保留少量内置安全回退台词。
/// </summary>
public sealed class DialogueRepository
{
    /// <summary>点击/时间问候在内置 JSON 全部缺失时的安全回退台词（仅兜底）。</summary>
    private static readonly Dictionary<string, string[]> FallbackByScene = new()
    {
        ["user_click"] = new[]
        {
            "在忙吗？我在这里等你。",
            "今天也一起加油吧。",
            "点击我会做随机动作哦。",
            "桌面宠物已连接。"
        },
        ["morning"] = new[] { "早上好，新的一天也一起加油吧。" },
        ["forenoon"] = new[] { "上午好，忙碌时也记得喝点水。" },
        ["lunch"] = new[] { "到午饭时间了，先好好吃饭吧。" },
        ["afternoon"] = new[] { "下午好，累了就休息几分钟。" },
        ["dinner"] = new[] { "晚饭时间到了，别忙到忘记吃饭。" },
        ["evening"] = new[] { "晚上好，今天也辛苦了。" },
        ["late_night"] = new[] { "已经很晚了，早点休息吧。" },
        ["deep_night"] = new[] { "夜深了，先放下工作好好睡一觉吧。" }
    };

    private readonly List<DialogueFile> _files = new();

    /// <summary>全部已加载台词条目（enabled 与否都在内，抽取时再过滤）。</summary>
    public IReadOnlyList<DialogueEntry> AllEntries { get; private set; } =
        new List<DialogueEntry>();

    /// <summary>全部有效（enabled=true 且有文本）条目。</summary>
    public IReadOnlyList<DialogueEntry> EnabledEntries { get; private set; } =
        new List<DialogueEntry>();

    /// <summary>成功加载的 JSON 文件数。</summary>
    public int LoadedFileCount { get; private set; }

    /// <summary>损坏/解析失败的文件名列表。</summary>
    public IReadOnlyList<string> FailedFiles { get; private set; } =
        new List<string>();

    /// <summary>台词总数。</summary>
    public int TotalEntryCount { get; private set; }

    /// <summary>相对 dialogue 根目录递归扫描并加载全部 JSON。</summary>
    public void LoadFromDirectory(string rootDirectory)
    {
        _files.Clear();
        var failed = new List<string>();
        var allEntries = new List<DialogueEntry>();

        string[] jsonFiles;
        try
        {
            if (!Directory.Exists(rootDirectory))
            {
                AppLog.Warn("DIALOGUE_DIRECTORY_MISSING path={0}", rootDirectory);
                jsonFiles = System.Array.Empty<string>();
            }
            else
            {
                jsonFiles = Directory.GetFiles(rootDirectory, "*.json", SearchOption.AllDirectories);
            }
        }
        catch (Exception ex)
        {
            AppLog.Error("DIALOGUE_SCAN_FAILED path={0} error={1}", rootDirectory, ex.Message);
            jsonFiles = System.Array.Empty<string>();
        }

        foreach (var file in jsonFiles)
        {
            try
            {
                var dialogue = JsonSerializer.Deserialize<DialogueFile>(
                    File.ReadAllText(file),
                    new JsonSerializerOptions { ReadCommentHandling = JsonCommentHandling.Skip });
                if (dialogue is null)
                {
                    failed.Add(Path.GetFileName(file));
                    AppLog.Warn("DIALOGUE_FILE_EMPTY name={0}", Path.GetFileName(file));
                    continue;
                }

                dialogue.SourceFile = MakeRelative(rootDirectory, file);
                _files.Add(dialogue);
                if (dialogue.Entries is { Count: > 0 })
                    allEntries.AddRange(dialogue.Entries);
            }
            catch (Exception ex)
            {
                failed.Add(Path.GetFileName(file));
                AppLog.Warn("DIALOGUE_FILE_SKIPPED name={0} error={1}", Path.GetFileName(file), ex.Message);
            }
        }

        LoadedFileCount = _files.Count;
        FailedFiles = failed;
        TotalEntryCount = allEntries.Count;
        AllEntries = allEntries;
        EnabledEntries = allEntries
            .Where(e => e.Enabled != false && !string.IsNullOrWhiteSpace(e.Text))
            .ToList();

        AppLog.Info("DIALOGUE_LOAD_SUMMARY files={0} totalEntries={1} enabled={2} failed={3}",
            LoadedFileCount, TotalEntryCount, EnabledEntries.Count, failed.Count);
        foreach (var name in failed)
            AppLog.Warn("DIALOGUE_FILE_FAILED name={0}", name);
    }

    /// <summary>按场景取文件；场景名以实际 JSON 的 scene 字段为准。</summary>
    public DialogueFile? FindScene(string scene)
    {
        return _files.FirstOrDefault(f => string.Equals(f.Scene, scene, System.StringComparison.Ordinal));
    }

    /// <summary>取某个场景的有效条目；无文件或无有效条目时返回空。</summary>
    public IReadOnlyList<DialogueEntry> GetEnabledEntriesForScene(string scene)
    {
        var file = FindScene(scene);
        if (file?.Entries is null)
            return System.Array.Empty<DialogueEntry>();
        return file.Entries
            .Where(e => e.Enabled != false && !string.IsNullOrWhiteSpace(e.Text))
            .ToList();
    }

    /// <summary>内置安全回退台词（仅当某场景完全无可用 JSON 条目时使用）。</summary>
    public string[] GetFallbackForScene(string scene)
    {
        return FallbackByScene.TryGetValue(scene, out var lines) ? lines : System.Array.Empty<string>();
    }

    private static string MakeRelative(string root, string fullPath)
    {
        var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(fullPath);
        if (full.StartsWith(rootFull, System.StringComparison.OrdinalIgnoreCase))
            return full.Substring(rootFull.Length).TrimStart(Path.DirectorySeparatorChar);
        return Path.GetFileName(full);
    }
}
