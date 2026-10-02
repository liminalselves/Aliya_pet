/**
 * 展示分段：逐行移植 misskey packages/frontend/src/utility/agent-message-segments.ts。
 * 把 assistant 回复拆成展示用气泡；数据库消息不变，空行是边界，
 * 但代码块/表格/列表/引用/HTML 块/跨行占位符保持完整。
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_RE = /^\s*(?:[-+*]|\d+[.)])\s+/;
const QUOTE_RE = /^\s*>/;
const THEMATIC_BREAK_RE = /^\s{0,3}(?:(?:-{3,})|(?:_{3,})|(?:\*{3,}))\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const PROSE_PAGE_CHARS = 72;
const INLINE_MARKUP_RE = /[`*_~\[\]<>]|https?:\/\//i;

/** 表情包 token（角色标签按语法即有效；全站表情须命中表情表，功能关闭时全部视为普通文本） */
const STICKER_TOKEN_RE = /\[\[agent_sticker\s+key=[a-zA-Z0-9_-]{1,32}\s*\]\]|:([a-zA-Z0-9_]+):/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateHtmlStack(line: string, stack: string[]): boolean {
  let sawHtml = false;
  for (const match of line.matchAll(/<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\/?>/g)) {
    if (match[0].startsWith('<!--')) {
      sawHtml = true;
      continue;
    }
    const name = match[1]!.toLowerCase();
    sawHtml = true;
    if (match[0].startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index !== -1) stack.splice(index);
    } else if (!match[0].endsWith('/>') && !VOID_HTML_TAGS.has(name)) {
      stack.push(name);
    }
  }
  return sawHtml;
}

/** 超长纯文本按句子与长度拆页；带 Markdown/HTML 的结构化行保持整体。 */
function splitLongProse(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= PROSE_PAGE_CHARS || INLINE_MARKUP_RE.test(trimmed)) return [trimmed];
  const sentences = trimmed.match(/[^。！？!?；;…]+(?:[。！？!?；;…]+|$)/g)?.map(part => part.trim()).filter(Boolean) ?? [trimmed];
  const pages: string[] = [];
  let current = '';
  const flush = () => {
    if (current) pages.push(current);
    current = '';
  };
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > PROSE_PAGE_CHARS) {
      if (current) flush();
      pages.push(rest.slice(0, PROSE_PAGE_CHARS));
      rest = rest.slice(PROSE_PAGE_CHARS);
    }
    if (!rest) continue;
    if (current && current.length + rest.length > PROSE_PAGE_CHARS) flush();
    current += rest;
  }
  flush();
  return pages.length ? pages : [trimmed];
}

/** 普通文本行内按有效表情包 token 切分；无效 token（如 12:30:45 的 :30:）不切分。 */
export function splitLineByStickerTokens(
  line: string,
  isEmoji: (name: string) => boolean = () => true,
  isSticker: (token: string) => boolean = () => true,
): string[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  const out: string[] = [];
  let cursor = 0;
  for (const match of trimmed.matchAll(STICKER_TOKEN_RE)) {
    const valid = match[1] !== undefined ? isEmoji(match[1]) : isSticker(match[0]);
    if (!valid) continue;
    const start = match.index ?? 0;
    const before = trimmed.slice(cursor, start).trim();
    if (before !== '') out.push(before);
    out.push(match[0]);
    cursor = start + match[0].length;
  }
  const rest = trimmed.slice(cursor).trim();
  if (rest !== '') out.push(rest);
  return out;
}

/**
 * 把一条 assistant 回复拆成展示气泡。空行分隔；thematic break 整行丢弃；
 * 单行普通文本再按有效表情包 token 切分。isEmoji 校验全站表情名是否真实存在
 * （如 12:30:45 的 :30: 不是表情，保持原文不切分）。
 */
export function splitAgentMessageIntoSegments(
  source: string,
  isEmoji: (name: string) => boolean = () => true,
  isSticker: (token: string) => boolean = () => true,
): string[] {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const segments: string[] = [];
  let i = 0;

  const push = (from: number, to: number) => {
    const text = lines.slice(from, to).join('\n').trim();
    if (text !== '') segments.push(text);
  };

  while (i < lines.length) {
    if (lines[i]!.trim() === '') {
      i++;
      continue;
    }

    if (THEMATIC_BREAK_RE.test(lines[i]!)) {
      i++;
      continue;
    }

    const start = i;
    const fence = lines[i]!.match(FENCE_RE)?.[1];
    if (fence) {
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${escapeRegExp(fence[0]!)}{${fence.length},}\\s*$`).test(lines[i]!)) i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    if (lines[i]!.includes('[[agent_draw') && !lines[i]!.includes(']]', lines[i]!.indexOf('[[agent_draw'))) {
      i++;
      while (i < lines.length && !lines[i]!.includes(']]')) i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    if (i + 1 < lines.length && lines[i]!.includes('|') && TABLE_SEPARATOR_RE.test(lines[i + 1]!)) {
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) i++;
      push(start, i);
      continue;
    }

    if (LIST_RE.test(lines[i]!)) {
      i++;
      while (i < lines.length) {
        const line = lines[i]!;
        if (LIST_RE.test(line) || /^\s{2,}\S/.test(line)) {
          i++;
          continue;
        }
        break;
      }
      push(start, i);
      continue;
    }

    if (QUOTE_RE.test(lines[i]!)) {
      i++;
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) i++;
      push(start, i);
      continue;
    }

    const htmlStack: string[] = [];
    let sawHtml = false;
    do {
      sawHtml = updateHtmlStack(lines[i]!, htmlStack) || sawHtml;
      i++;
    } while (sawHtml && htmlStack.length > 0 && i < lines.length);
    if (i - start === 1) {
      // 单行普通文本：表情包独占一页；纯文本过长时再按句子和长度拆页。
      for (const piece of splitLineByStickerTokens(lines[start]!, isEmoji, isSticker)) {
        segments.push(...splitLongProse(piece));
      }
    } else {
      // 多行 HTML 块保持整体，不按 token 拆分
      push(start, i);
    }
  }

  return segments.length > 0 ? segments : (source.trim() === '' ? [] : [source.trim()]);
}

/** 展示用逐段延迟：与 misskey 权威实现一致。 */
export function agentSegmentDelayMs(segment: string): number {
  const visibleChars = segment.replace(/<[^>]*>|\s+/g, '').length;
  return Math.max(1000, Math.min(3000, 1000 + visibleChars * 20));
}
