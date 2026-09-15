/**
 * 纯字符串组合：规则过滤 → 心率指令剥离 → 展示分段 → token 扫描 → HTML。
 * 正文走 ../render 的先转义 MFM+Markdown 管线；结构化标签全部经 esc.ts 转义与
 * http(s) 地址白名单校验。生图卡片正文用 \u0000 占位符留给渲染器按状态填充。
 */
import { renderMarkdown } from '../render';
import { escapeAttr, escapeHtml, safeHttpUrl } from './esc';
import { attachmentImageUrl, stickerImageUrl } from './emoji';
import { applyDisplayRules } from './rules';
import { splitAgentMessageIntoSegments } from './segments';
import { scanAgentTokens, type DrawSize } from './tokens';
import type { AgentRegexRule, ChatRole, DriveFileLike, CustomEmojiInfo } from './types';

/** 与 Aliya_web 一致：[[heart_rate:min,max]] 是展示指令，不允许泄漏到正文。 */
const HEART_RATE_RE = /\[\[heart_rate:\s*(\d+)\s*,\s*(\d+)\s*\]\]/g;
const HEART_RATE_MAX = 300;

export interface DrawPartInfo {
  index: number;
  size: DrawSize;
  tag: string;
}

export interface ComposedMessage {
  /** 当前快照 HTML（生图卡片正文为 \u0000index\u0000 占位符）。 */
  html: string;
  /** 按出现顺序的生图占位符（index 已跨 segment 连续编号）。 */
  draws: DrawPartInfo[];
  /** 心率指令的最终区间（多次出现时以最后一次为准）。 */
  heartRate?: { min: number; max: number };
  /** 用户消息附图地址（无可展示附图时缺省）。 */
  attachmentUrl?: string;
}

export interface ComposeOptions {
  role: ChatRole;
  stickersEnabled: boolean;
  resolveSticker?: (key: string) => DriveFileLike | undefined;
  resolveEmoji?: (name: string) => CustomEmojiInfo | undefined;
  segmented?: boolean;
  regexRules?: ReadonlyArray<AgentRegexRule>;
  file?: DriveFileLike | null;
}

function clampHeartRate(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, HEART_RATE_MAX);
}

function extractHeartRate(text: string): { text: string; range?: { min: number; max: number } } {
  let clean = text;
  let range: { min: number; max: number } | undefined;
  clean = clean.replace(HEART_RATE_RE, (_, a: string, b: string) => {
    let min = clampHeartRate(Number.parseInt(a, 10));
    let max = clampHeartRate(Number.parseInt(b, 10));
    if (min > max) { const t = min; min = max; max = t; }
    range = { min, max };
    return '';
  });
  return { text: clean.trim(), range };
}

function stickerHtml(key: string, file: DriveFileLike | undefined): string {
  const url = stickerImageUrl(file);
  if (!url) return `<span class="msk-sticker-missing">表情包 ${escapeHtml(key)} 不可用</span>`;
  return `<img class="msk-sticker msk-zoom" src="${escapeAttr(safeHttpUrl(url))}" alt="表情包 ${escapeAttr(key)}" title="${escapeAttr(key)}" loading="lazy">`;
}

function emojiHtml(name: string, emoji: CustomEmojiInfo): string {
  return `<img class="msk-emoji-img msk-zoom" src="${escapeAttr(safeHttpUrl(emoji.url))}" alt=":${escapeAttr(name)}:" title=":${escapeAttr(name)}:" loading="lazy">`;
}

function drawCardHtml(info: DrawPartInfo): string {
  const tag = info.tag ? ` <span class="msk-draw-tag">${escapeHtml(info.tag)}</span>` : '';
  return `<div class="msk-draw-card" data-msk-draw="${info.index}">`
    + `<div class="msk-draw-head"><span class="msk-draw-title">配图</span>${tag}</div>`
    + `<div class="msk-draw-body" data-msk-draw-body="${info.index}">\u0000${info.index}\u0000</div>`
    + `</div>`;
}

/** 组合一条消息的展示 HTML；生图状态由渲染器填充占位符。 */
export function composeMessage(text: string, options: ComposeOptions): ComposedMessage {
  const role = options.role;
  // 1. 正则显示规则（只应用 hide）
  let content = applyDisplayRules(text, options.regexRules, role);
  // 2. 心率指令剥离
  const hr = extractHeartRate(content);
  content = hr.text;
  // 3. 展示分段（仅 assistant 且会话开启分段输出）；表情名须真实存在才切分，避免 12:30:45 被拆散
  const segments = role === 'assistant' && options.segmented === true
    ? splitAgentMessageIntoSegments(content, name => options.resolveEmoji?.(name) !== undefined)
    : [content];

  const draws: DrawPartInfo[] = [];
  let drawOffset = 0;
  const segmentHtml: string[] = [];
  for (const segment of segments) {
    const parts = scanAgentTokens(segment, {
      role,
      stickersEnabled: options.stickersEnabled && role === 'assistant',
      resolveEmoji: options.resolveEmoji,
      drawEnabled: role === 'assistant',
      drawIndexOffset: drawOffset,
    });
    let html = '';
    let hasDraw = false;
    for (const part of parts) {
      if (part.type === 'text') {
        html += renderMarkdown(segment.slice(part.start, part.end));
      } else if (part.type === 'sticker') {
        html += stickerHtml(part.key, options.resolveSticker?.(part.key));
      } else if (part.type === 'emoji') {
        const emoji = options.resolveEmoji?.(part.name);
        if (emoji?.url) html += emojiHtml(part.name, emoji);
        else html += renderMarkdown(segment.slice(part.start, part.end));
      } else {
        hasDraw = true;
        draws.push({ index: part.index, size: part.size, tag: part.tag });
        html += drawCardHtml({ index: part.index, size: part.size, tag: part.tag });
      }
    }
    drawOffset = draws.length;
    if (html !== '') segmentHtml.push(`<div class="msk-segment${hasDraw && parts.length === 1 ? ' msk-segment-draw' : ''}">${html}</div>`);
  }

  const attachmentUrl = role === 'user' ? attachmentImageUrl(options.file) : null;
  const attachment = attachmentUrl
    ? `<div class="msk-attachment"><img class="msk-attachment-img msk-zoom" src="${escapeAttr(safeHttpUrl(attachmentUrl))}" alt="附图" loading="lazy"></div>`
    : '';

  return {
    html: attachment + segmentHtml.join(''),
    draws,
    heartRate: hr.range,
    attachmentUrl: attachmentUrl ?? undefined,
  };
}
