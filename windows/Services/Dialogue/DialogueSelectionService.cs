using System;
using System.Collections.Generic;
using System.Linq;
using AliyaPet.Models.Dialogue;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 台词抽取：
///   - enabled=false 永不抽取
///   - selectionMode=shuffle_bag：洗牌袋，同一轮内不重复，新一轮重新洗牌
///   - 存在 weight：加权抽取（一轮内加权不重复）
///   - 存在 minRepeatDays：最短重复天数内不重复
///   - 场景无有效条目时使用内置安全回退台词
/// </summary>
public sealed class DialogueSelectionService
{
    public const string ShuffleBagMode = "shuffle_bag";

    private readonly DialogueRepository _repository;
    private readonly Random _random = new();

    private readonly Dictionary<string, List<DialogueEntry>> _bags = new();
    private readonly Dictionary<string, List<DialogueEntry>> _tagBags = new();

    public DialogueSelectionService(DialogueRepository repository)
    {
        _repository = repository;
    }

    /// <summary>按场景抽取一条台词。</summary>
    public DialogueEntry Select(string scene)
    {
        var entries = _repository.GetEnabledEntriesForScene(scene);
        var now = DateTime.Now.Date;

        var candidates = entries
            .Where(e => e.Enabled != false)
            .ToList();

        if (candidates.Count == 0)
        {
            AppLog.Warn("DIALOGUE_SCENE_EMPTY scene={0} use_fallback", scene);
            var fallback = _repository.GetFallbackForScene(scene);
            if (fallback.Length == 0)
            {
                AppLog.Warn("DIALOGUE_SCENE_NO_FALLBACK scene={0}", scene);
                return new DialogueEntry { Id = "fallback", Text = "今天也一起加油吧。", Enabled = true };
            }
            var line = fallback[_random.Next(fallback.Length)];
            return new DialogueEntry { Id = $"fallback_{scene}", Text = line, Enabled = true };
        }

        // minRepeatDays 过滤：最近 N 天内已被抽取的条目本轮不参与
        var available = candidates
            .Where(e => e.MinRepeatDays is null or <= 0
                        || e.LastSelectedDate is null
                        || (now - e.LastSelectedDate.Value).TotalDays >= e.MinRepeatDays.Value)
            .ToList();
        if (available.Count == 0)
        {
            // 全部都在冷却中：放宽，优先选择冷却时间最长的
            available = candidates
                .OrderBy(e => e.LastSelectedDate ?? DateTime.MinValue)
                .ToList();
            AppLog.Info("DIALOGUE_ALL_ON_COOLDOWN scene={0}", scene);
        }

        DialogueEntry entry;
        if (string.Equals(_repository.FindScene(scene)?.SelectionMode, ShuffleBagMode, StringComparison.OrdinalIgnoreCase))
        {
            entry = SelectFromBag(scene, available);
        }
        else
        {
            entry = WeightedPick(available);
        }

        entry.LastSelectedDate = now;
        return entry;
    }

    /// <summary>从全部已加载的有效条目中随机抽取一条（随机说话用）。</summary>
    public DialogueEntry SelectRandom()
    {
        var enabled = _repository.EnabledEntries;
        if (enabled.Count == 0)
        {
            return new DialogueEntry { Id = "fallback", Text = "今天也一起加油吧。", Enabled = true };
        }
        var entry = WeightedPick(enabled.ToList());
        entry.LastSelectedDate = DateTime.Now.Date;
        return entry;
    }

    /// <summary>
    /// 按场景 + tag 抽取（抚摸台词等分组场景用）。同一 (scene:tag) 使用独立洗牌袋，
    /// 一轮内不重复；weightBoost 提高该组权重（用于 petting_repeat 随当日次数增强）。
    /// </summary>
    public DialogueEntry? SelectByTag(string scene, string tag, IReadOnlyCollection<string>? excludeIds = null, double weightBoost = 0)
    {
        var entries = _repository.GetEnabledEntriesForScene(scene)
            .Where(e => e.Tags is not null && e.Tags.Contains(tag))
            .ToList();
        if (entries.Count == 0)
        {
            AppLog.Warn("DIALOGUE_TAG_EMPTY scene={0} tag={1}", scene, tag);
            return null;
        }

        if (excludeIds is { Count: > 0 })
        {
            var filtered = entries.Where(e => e.Id is null || !excludeIds.Contains(e.Id)).ToList();
            if (filtered.Count > 0)
                entries = filtered;
        }

        var now = DateTime.Now.Date;
        var available = entries
            .Where(e => e.Enabled != false
                        && (e.MinRepeatDays is null or <= 0
                            || e.LastSelectedDate is null
                            || (now - e.LastSelectedDate.Value).TotalDays >= e.MinRepeatDays.Value))
            .ToList();
        if (available.Count == 0)
            available = entries;

        string bagKey = scene + ":" + tag;
        if (!_tagBags.TryGetValue(bagKey, out var bag) || bag.Count == 0)
        {
            bag = BuildBag(available, weightBoost);
            _tagBags[bagKey] = bag;
        }

        var entry = bag[0];
        bag.RemoveAt(0);
        entry.LastSelectedDate = now;
        return entry;
    }

    private DialogueEntry SelectFromBag(string scene, List<DialogueEntry> available)
    {
        if (!_bags.TryGetValue(scene, out var bag) || bag.Count == 0)
        {
            bag = BuildBag(available);
            _bags[scene] = bag;
        }

        var entry = bag[0];
        bag.RemoveAt(0);
        return entry;
    }

    private List<DialogueEntry> BuildBag(List<DialogueEntry> available, double weightBoost = 0)
    {
        var hasWeight = available.Any(e => e.Weight is > 0) || weightBoost > 0;
        if (!hasWeight)
        {
            var list = available.ToList();
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = _random.Next(i + 1);
                (list[i], list[j]) = (list[j], list[i]);
            }
            return list;
        }

        // 加权抽取不重复：每次从剩余中按权重抽取并移除，形成一轮
        double EffectiveWeight(DialogueEntry e) => Math.Max(0.01, (e.Weight ?? 1.0) * (1.0 + weightBoost));

        var remaining = available.ToList();
        var result = new List<DialogueEntry>(remaining.Count);
        while (remaining.Count > 0)
        {
            double total = remaining.Sum(EffectiveWeight);
            double roll = _random.NextDouble() * total;
            double acc = 0;
            int pick = remaining.Count - 1;
            for (int i = 0; i < remaining.Count; i++)
            {
                acc += EffectiveWeight(remaining[i]);
                if (roll <= acc) { pick = i; break; }
            }
            result.Add(remaining[pick]);
            remaining.RemoveAt(pick);
        }
        return result;
    }

    private DialogueEntry WeightedPick(List<DialogueEntry> available)
    {
        var hasWeight = available.Any(e => e.Weight is > 0);
        if (!hasWeight)
            return available[_random.Next(available.Count)];

        double total = available.Sum(e => Math.Max(0.01, e.Weight ?? 1.0));
        double roll = _random.NextDouble() * total;
        double acc = 0;
        foreach (var e in available)
        {
            acc += Math.Max(0.01, e.Weight ?? 1.0);
            if (roll <= acc) return e;
        }
        return available[available.Count - 1];
    }
}
