using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using AliyaPet.Models.Dialogue;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 气泡分页：
///   - 反斜杠 \ 作为人工分页符（显示时不包含）
///   - 无人工分页符时按标点与字符长度智能分页
///   - 不让标点单独出现在下一页开头；不切断英文单词/数字
///   - 超过 maxPages 时重新均衡分页
/// </summary>
public sealed class DialoguePaginationService
{
    public const int DefaultSinglePageMaxChars = 18;
    public const int DefaultMaxPages = 3;

    private static readonly HashSet<char> Punctuation = new()
    {
        '，', '。', '？', '！', '、', '；', '：', '…', '～', '·',
        '，', '。', '?', '!', ',', ';', ':', '.'
    };

    /// <summary>对最终文本分页。</summary>
    public IReadOnlyList<DialoguePage> Paginate(string text, int? singlePageMaxChars, int? maxPages)
    {
        int target = Math.Max(1, singlePageMaxChars ?? DefaultSinglePageMaxChars);
        int maxP = Math.Max(1, maxPages ?? DefaultMaxPages);

        if (string.IsNullOrWhiteSpace(text))
            return new List<DialoguePage> { new(0, "") };

        // 1. 人工分页符：显式拆分优先
        var explicitPages = text
            .Split('\\')
            .Select(p => p.Trim())
            .Where(p => p.Length > 0)
            .ToList();
        if (explicitPages.Count > 1)
        {
            if (explicitPages.Count <= maxP)
                return ToPages(explicitPages);
            // 显式页数超过 maxPages：忽略显式分页，整体重新均衡
            var flat = string.Concat(explicitPages);
            return Rebalance(flat, target, maxP);
        }

        // 2. 智能分页
        var units = Tokenize(text);
        var pages = Pack(units, target);
        if (pages.Count > maxP)
            return Rebalance(text, target, maxP);

        return ToPages(pages);
    }

    private IReadOnlyList<DialoguePage> Rebalance(string text, int target, int maxPages)
    {
        var units = Tokenize(text);
        int totalChars = units.Sum(u => u.Text.Length);
        int perPage = Math.Max(1, (int)Math.Ceiling(totalChars / (double)maxPages));
        var pages = Pack(units, perPage);
        // 仍超过 maxPages 时从末尾向前合并，保证不粗暴截断、页数不超限
        while (pages.Count > maxPages && pages.Count > 1)
        {
            string merged = pages[pages.Count - 2] + pages[pages.Count - 1];
            pages.RemoveAt(pages.Count - 1);
            pages[pages.Count - 1] = merged;
        }
        return ToPages(pages);
    }

    private List<string> Pack(IReadOnlyList<Unit> units, int target)
    {
        var pages = new List<string>();
        int i = 0;
        while (i < units.Count)
        {
            int j = i;
            int chars = 0;
            int lastBreak = -1;
            while (j < units.Count)
            {
                var u = units[j];
                if (chars + u.Text.Length > target)
                    break;
                chars += u.Text.Length;
                if (u.IsPunct)
                    lastBreak = j + 1;
                j++;
            }

            if (j >= units.Count)
            {
                pages.Add(Join(units, i, units.Count));
                break;
            }

            int cut;
            if (lastBreak > i && lastBreak <= j)
            {
                cut = lastBreak;
            }
            else if (units[j].IsPunct && chars + units[j].Text.Length <= target + 2)
            {
                cut = j + 1; // 吸收标点到本页末尾，避免下一页以标点开头
            }
            else
            {
                cut = j;
            }

            // 防止无进展（单个单元超过 target 时整体成一页，避免死循环）
            if (cut <= i)
                cut = i + 1;

            pages.Add(Join(units, i, cut));
            i = cut;
        }

        // 清理空页
        pages.RemoveAll(p => p.Length == 0);
        return pages.Count == 0 ? new List<string> { "" } : pages;
    }

    private static string Join(IReadOnlyList<Unit> units, int start, int end)
    {
        var sb = new StringBuilder();
        for (int i = start; i < end && i < units.Count; i++)
            sb.Append(units[i].Text);
        return sb.ToString().Trim();
    }

    private static IReadOnlyList<DialoguePage> ToPages(IEnumerable<string> texts)
    {
        int index = 0;
        return texts.Select(t => new DialoguePage(index++, t)).ToList();
    }

    private readonly struct Unit
    {
        public Unit(string text, bool isPunct)
        {
            Text = text;
            IsPunct = isPunct;
        }

        public string Text { get; }
        public bool IsPunct { get; }
    }

    /// <summary>拆分为不可再切分的单元：汉字单字 / 连续英文或数字词 / 标点。</summary>
    private static List<Unit> Tokenize(string text)
    {
        var result = new List<Unit>();
        int i = 0;
        while (i < text.Length)
        {
            char c = text[i];
            if (Punctuation.Contains(c))
            {
                result.Add(new Unit(c.ToString(), true));
                i++;
                continue;
            }

            if (IsWordChar(c))
            {
                int start = i;
                while (i < text.Length && IsWordChar(text[i]))
                    i++;
                result.Add(new Unit(text.Substring(start, i - start), false));
                continue;
            }

            result.Add(new Unit(c.ToString(), false));
            i++;
        }
        return result;
    }

    private static bool IsWordChar(char c)
    {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }
}
