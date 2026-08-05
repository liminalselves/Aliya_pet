using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using AliyaPet.Models.Dialogue;
using AliyaPet.Models.Mouth;

namespace AliyaPet.Services.Mouth;

/// <summary>
/// 台词文本 -> 嘴型时间轴：
///   去除气泡分页符 -> 分割汉字/英文/数字/标点 -> 中文转拼音 -> 韵母映射嘴型
///   -> 标点停顿 -> 生成时间轴（每帧由 MouthAnimationRunner 平滑写入）。
/// 拼音转换完全离线（预计算表）；表外汉字回退自然开合。
/// </summary>
public sealed class TextMouthTimelineBuilder
{
    private readonly PinyinMouthMapper _mapper;
    private readonly Random _random = new();

    private static readonly HashSet<char> NumberDigits = new() { '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' };

    private static readonly Dictionary<char, int> PauseRangeMs = new()
    {
        ['、'] = 100,  // 顿号 ~80-120
        ['，'] = 180,  // 逗号 ~140-220
        ['。'] = 320,  // 句号 ~260-380
        ['？'] = 350,  // 问号 ~280-420
        ['！'] = 290,  // 感叹号 ~220-360
        ['…'] = 525   // 省略号 ~400-650
    };

    private const int PageBreakPauseMinMs = 350;
    private const int PageBreakPauseMaxMs = 550;

    public TextMouthTimelineBuilder(PinyinMouthMapper mapper)
    {
        _mapper = mapper;
    }

    /// <summary>由最终台词（含人工分页符 \）构建嘴型时间轴。</summary>
    public MouthTimeline Build(string fullText)
    {
        var items = new List<MouthTimelineItem>();
        if (string.IsNullOrWhiteSpace(fullText))
            return new MouthTimeline(items);

        int pacingCount = CountSpeechUnits(fullText);
        int baseMs = GetBaseSyllableMs(pacingCount);
        int t = 0;

        foreach (var unit in Tokenize(fullText))
        {
            if (unit == "\\")
            {
                int pause = _random.Next(PageBreakPauseMinMs, PageBreakPauseMaxMs + 1);
                items.Add(new MouthTimelineItem(t, pause, MouthShape.Closed, true));
                t += pause;
                continue;
            }

            if (IsPunctuation(unit))
            {
                int pause = PauseRangeMs.TryGetValue(unit[0], out var mid) ? mid : 160;
                int lo = Math.Max(60, pause - 40);
                int hi = pause + 40;
                int actual = _random.Next(lo, hi + 1);
                items.Add(new MouthTimelineItem(t, actual, MouthShape.Closed, true));
                t += actual;
                continue;
            }

            // 单个汉字
            if (unit.Length == 1 && IsCjk(unit[0]))
            {
                t = AppendCjkSyllable(items, unit[0], t, baseMs);
                continue;
            }

            // 数字串 -> 中文读法近似展开
            if (unit.All(NumberDigits.Contains))
            {
                foreach (var ch in NumberToSyllables(unit))
                    t = AppendCjkSyllable(items, ch, t, baseMs);
                continue;
            }

            // 英文词 -> 按元音分组近似
            foreach (var ch in unit)
                t = AppendLatinLetter(items, ch, t, baseMs);
        }

        return new MouthTimeline(items);
    }

    /// <summary>计算每个气泡页的开始时间（毫秒），用于翻页与嘴型同步。</summary>
    public IReadOnlyList<int> ComputePageStartMilliseconds(string fullText, IReadOnlyList<DialoguePage> pages)
    {
        int pacingCount = CountSpeechUnits(fullText);
        var starts = new List<int> { 0 };
        int cumulative = 0;
        for (int i = 0; i + 1 < pages.Count; i++)
        {
            cumulative += EstimateSegmentDuration(pages[i].Text, pacingCount);
            starts.Add(cumulative);
        }
        return starts;
    }

    /// <summary>与 Build 使用相同节奏常量的确定性估时（用于翻页对齐）。</summary>
    public int EstimateSegmentDuration(string segment, int pacingCount)
    {
        if (string.IsNullOrEmpty(segment))
            return 0;
        int baseMs = GetBaseSyllableMs(pacingCount);
        int total = 0;
        foreach (var unit in Tokenize(segment))
        {
            if (unit == "\\")
            {
                total += (PageBreakPauseMinMs + PageBreakPauseMaxMs) / 2;
                continue;
            }
            if (IsPunctuation(unit))
            {
                int mid = PauseRangeMs.TryGetValue(unit[0], out var m) ? m : 160;
                total += mid;
                continue;
            }
            if (unit.Length == 1 && IsCjk(unit[0]))
            {
                total += baseMs;
                if (_mapper.IsClosedInit(unit[0]))
                    total += 40;
                continue;
            }
            if (unit.All(NumberDigits.Contains))
            {
                total += NumberToSyllables(unit).Count * baseMs;
                continue;
            }
            total += unit.Length * (baseMs / 2 + 10);
        }
        return total;
    }

    private int AppendCjkSyllable(List<MouthTimelineItem> items, char ch, int t, int baseMs)
    {
        var category = _mapper.GetFinalCategory(ch);
        double random01 = _random.NextDouble();
        var shape = _mapper.GetShape(category, random01);

        if (_mapper.IsClosedInit(ch))
        {
            // b/p/m：先短暂闭嘴
            int closedMs = _random.Next(30, 51);
            items.Add(new MouthTimelineItem(t, closedMs, new MouthShape(_random.NextDouble() * 0.06, 0)));
            t += closedMs;
            shape = new MouthShape(Math.Max(0.3, shape.OpenY), shape.Form);
        }
        else if (_mapper.IsSoftInit(ch))
        {
            // f：轻微张嘴，不必完全闭合
            shape = new MouthShape(Math.Min(0.35, shape.OpenY * 0.55), shape.Form * 0.5);
        }

        int syllable = ApplyJitter(baseMs);
        items.Add(new MouthTimelineItem(t, syllable, shape));
        return t + syllable;
    }

    private int AppendLatinLetter(List<MouthTimelineItem> items, char ch, int t, int baseMs)
    {
        var lower = char.ToLowerInvariant(ch);
        MouthShape shape;
        if (lower is 'a') shape = _mapper.GetShape(FinalCategory.A, _random.NextDouble());
        else if (lower is 'e') shape = _mapper.GetShape(FinalCategory.E, _random.NextDouble());
        else if (lower is 'i' or 'y') shape = _mapper.GetShape(FinalCategory.I, _random.NextDouble());
        else if (lower is 'o') shape = _mapper.GetShape(FinalCategory.O, _random.NextDouble());
        else if (lower is 'u') shape = _mapper.GetShape(FinalCategory.U, _random.NextDouble());
        else shape = new MouthShape(_random.NextDouble() * 0.08, 0); // 辅音近似闭合

        int duration = lower is 'a' or 'e' or 'i' or 'o' or 'u' or 'y'
            ? ApplyJitter(baseMs)
            : Math.Max(35, ApplyJitter(baseMs) / 2);
        items.Add(new MouthTimelineItem(t, duration, shape));
        return t + duration;
    }

    private int ApplyJitter(int baseMs)
    {
        // 音节时长 ±10%
        int delta = (int)(baseMs * 0.10);
        return Math.Max(60, baseMs + _random.Next(-delta, delta + 1));
    }

    private int CountSpeechUnits(string text)
    {
        int count = 0;
        foreach (var unit in Tokenize(text))
        {
            if (unit == "\\" || IsPunctuation(unit))
                continue;
            if (unit.Length == 1 && IsCjk(unit[0]))
            {
                count++;
                continue;
            }
            if (unit.All(NumberDigits.Contains))
            {
                count += NumberToSyllables(unit).Count;
                continue;
            }
            count += unit.Length;
        }
        return count;
    }

    private static int GetBaseSyllableMs(int speechUnits)
    {
        if (speechUnits <= 6) return 150; // 短句稍慢
        if (speechUnits <= 14) return 132;
        return 112;                        // 长句适度加快
    }

    /// <summary>数字 -> 中文读法近似音节（如 3026 -> 三/千/零/二/十/六，17 -> 十/七）。</summary>
    private static IReadOnlyList<char> NumberToSyllables(string digits)
    {
        const string digitNames = "零一二三四五六七八九";
        var result = new List<char>();
        int len = digits.Length;
        if (len > 4)
        {
            // 超出千位时按位直读
            foreach (var d in digits)
                result.Add(digitNames[d - '0']);
            return result;
        }

        for (int i = 0; i < len; i++)
        {
            int d = digits[i] - '0';
            int place = len - i - 1;
            if (d == 0)
            {
                if (digits.Skip(i + 1).Any(c => c != '0'))
                    result.Add(digitNames[0]);
                continue;
            }
            if (d == 1 && place == 1 && len == 2)
            {
                result.Add(digitNames[1]); // 十
                continue;
            }
            result.Add(digitNames[d]);
            if (place == 3) result.Add('千');
            else if (place == 2) result.Add('百');
            else if (place == 1) result.Add('十');
        }
        return result;
    }

    private static IEnumerable<string> Tokenize(string text)
    {
        int i = 0;
        while (i < text.Length)
        {
            char c = text[i];
            if (c == '\\')
            {
                yield return "\\";
                i++;
                continue;
            }
            if (IsPunctuation(c.ToString()))
            {
                yield return c.ToString();
                i++;
                continue;
            }
            if (IsCjk(c))
            {
                yield return c.ToString();
                i++;
                continue;
            }
            if (char.IsLetter(c) || NumberDigits.Contains(c))
            {
                int start = i;
                while (i < text.Length && (char.IsLetter(text[i]) || NumberDigits.Contains(text[i])))
                    i++;
                yield return text.Substring(start, i - start);
                continue;
            }
            yield return c.ToString();
            i++;
        }
    }

    private static bool IsCjk(char c) => c >= 0x4E00 && c <= 0x9FFF;

    private static bool IsPunctuation(string unit)
    {
        if (unit.Length != 1) return false;
        return PauseRangeMs.ContainsKey(unit[0])
               || unit[0] is '；' or '：' or '～' or '·';
    }
}
