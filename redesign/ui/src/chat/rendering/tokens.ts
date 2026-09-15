/**
 * agent 消息 token 扫描：角色贴纸 / 生图占位符 / 全站表情三种记号一起扫描。
 * 分支顺序与捕获组一一对应（sticker key=1，draw size=2、tag=3，emoji name=4），
 * 与 misskey agent-session.message.vue 的 AGENT_STICKER_OR_DRAW_RE 保持一致。
 */
import type { ChatRole } from './types';

export type DrawSize = 'portrait' | 'landscape' | 'square';

export type AgentTokenPart =
  | { type: 'text'; start: number; end: number }
  | { type: 'sticker'; start: number; end: number; key: string }
  | { type: 'emoji'; start: number; end: number; name: string }
  | { type: 'draw'; start: number; end: number; index: number; size: DrawSize; tag: string };

const AGENT_STICKER_OR_DRAW_RE = /\[\[agent_sticker\s+key=([a-zA-Z0-9_-]{1,32})\s*\]\]|\[\[agent_draw(?:\s+size=(portrait|landscape|square))?\s+tag=([\s\S]*?)\]\]|:([a-zA-Z0-9_]+):/g;

export interface ScanOptions {
  role: ChatRole;
  /** 角色贴纸渲染条件（misskey：assistant 且实例开启 agentStickerEnabled）；不满足时记号保持字面文本。 */
  stickersEnabled: boolean;
  /** 全站表情命中表情表且带 url 时才切分，否则保持字面文本（如时间 12:30:45）。 */
  resolveEmoji?: (name: string) => { url?: string | null } | undefined;
  /** 生图占位符只在 assistant 消息切分为卡片；用户消息保持字面文本。 */
  drawEnabled?: boolean;
  /** 跨 segment 的生图占位符序号偏移（与 misskey drawOffset 一致）。 */
  drawIndexOffset?: number;
}

/**
 * 把一段文本切成 text/sticker/emoji/draw 部件；text 部件交给 Markdown 渲染。
 * 无有效记号时返回单个 text 部件，行为与不扫描一致。
 */
export function scanAgentTokens(text: string, options: ScanOptions): AgentTokenPart[] {
  const parts: AgentTokenPart[] = [];
  let lastIndex = 0;
  let localDrawIndex = 0;
  // 角色贴纸仅 assistant 渲染（misskey：role === 'assistant' && agentStickerEnabled）
  const stickerRenderable = options.stickersEnabled && options.role === 'assistant';
  const pushText = (from: number, to: number) => {
    if (to > from) parts.push({ type: 'text', start: from, end: to });
  };
  for (const match of text.matchAll(AGENT_STICKER_OR_DRAW_RE)) {
    const start = match.index ?? 0;
    if (match[4] !== undefined) {
      // 全站表情分支：仅命中表情表且有 url 时才切分为贴纸图块
      const emoji = options.resolveEmoji?.(match[4]);
      if (!emoji || !emoji.url) continue;
      pushText(lastIndex, start);
      parts.push({ type: 'emoji', start, end: start + match[0].length, name: match[4] });
      lastIndex = start + match[0].length;
    } else if (match[1] !== undefined) {
      // 角色贴纸分支：不满足渲染条件时保持字面文本，不切分
      if (!stickerRenderable) continue;
      pushText(lastIndex, start);
      parts.push({ type: 'sticker', start, end: start + match[0].length, key: match[1] });
      lastIndex = start + match[0].length;
    } else {
      // 生图占位符分支：尺寸缺省或非法时回退 portrait（与权威端一致）
      if (!options.drawEnabled) continue;
      pushText(lastIndex, start);
      const size: DrawSize = match[2] === 'landscape' || match[2] === 'square' || match[2] === 'portrait' ? match[2] : 'portrait';
      parts.push({
        type: 'draw',
        start,
        end: start + match[0].length,
        index: (options.drawIndexOffset ?? 0) + localDrawIndex,
        size,
        tag: String(match[3] ?? '').trim(),
      });
      localDrawIndex++;
      lastIndex = start + match[0].length;
    }
  }
  pushText(lastIndex, text.length);
  return parts.length > 0 ? parts : [{ type: 'text', start: 0, end: text.length }];
}
