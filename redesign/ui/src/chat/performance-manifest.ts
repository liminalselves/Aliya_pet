/**
 * 表演能力清单与 [[agent_cue]] 指令解析。
 * 清单是 AI 可用表情/动作的唯一权威来源（name + 中文 hint），随聊天请求上报——
 * 服务端把「携带清单」识别为桌宠环境并注入表演协议（docs/PERFORMANCE.md）。
 * 与 16.model3.json 的 Expressions、actions.json、behavior.ts ACTION_LIBRARY 四表同步。
 */
import type { PerformanceCue } from './types';

export interface PerformanceItem {
  name: string;
  hint: string;
}

export const PERFORMANCE_EXPRESSIONS: readonly PerformanceItem[] = [
  { name: 'neutral', hint: '平静' },
  { name: 'happy', hint: '开心' },
  { name: 'angry', hint: '生气' },
  { name: 'sad', hint: '难过' },
  { name: 'surprised', hint: '惊讶' },
  { name: 'shy', hint: '害羞' },
  { name: 'sleepy', hint: '困倦' },
  { name: 'smug', hint: '得意' },
  { name: 'speechless', hint: '无语' },
  { name: 'worried', hint: '担心' },
  { name: 'serious', hint: '认真' },
  { name: 'hit', hint: '受打击' },
];

export const PERFORMANCE_ACTIONS: readonly PerformanceItem[] = [
  { name: 'nod', hint: '点头附和' },
  { name: 'sway', hint: '摇摆身体' },
  { name: 'shake', hint: '摇头' },
  { name: 'stretch', hint: '伸懒腰' },
  { name: 'wave', hint: '挥手打招呼' },
  { name: 'doubt', hint: '歪头疑惑' },
  { name: 'angry', hint: '气得发抖' },
  { name: 'yawn', hint: '打哈欠' },
  { name: 'walk', hint: '原地踱步' },
];

export interface PerformanceRequestPayload {
  expressions: PerformanceItem[];
  actions: PerformanceItem[];
}

/** 随 agents/messages/send 上报；携带即桌宠环境。 */
export function performanceRequestPayload(): PerformanceRequestPayload {
  return {
    expressions: PERFORMANCE_EXPRESSIONS.map(item => ({ ...item })),
    actions: PERFORMANCE_ACTIONS.map(item => ({ ...item })),
  };
}

/** 严格解析：整段恰为一个合法指令令牌（express 在前、play 在后，独占一行协议）。 */
const CUE_SEGMENT_RE = /^\[\[agent_cue\s+(?:express=([a-z0-9_-]{1,32})\s*)?(?:play=([a-z0-9_-]{1,32})\s*)?\]\]$/i;

/** 分段播放中命中整段指令时解析出表演内容；非法（缺名/畸形）返回 null。 */
export function parseCueSegment(segment: string): PerformanceCue | null {
  const m = segment.trim().match(CUE_SEGMENT_RE);
  if (!m) return null;
  const cue: PerformanceCue = {};
  if (m[1]) cue.expression = m[1].toLowerCase();
  if (m[2]) cue.action = m[2].toLowerCase();
  return cue.expression || cue.action ? cue : null;
}

/** 剥离表演指令（含畸形变体）：独占行连同换行移除、行内残留清理、空行收敛。
 *  与 misskey 端 stripAgentCueTokens 同款；记录屏渲染与文本段内残留兜底共用。 */
export function stripCueTokens(text: string): string {
  if (!text || !/\[\[agent_cue\b[^\]\n]*\]\]/iu.test(text)) return text;
  return text
    .replace(/^[ \t]*\[\[agent_cue\b[^\]\n]*\]\][ \t]*\r?\n?/gimu, '')
    .replace(/\[\[agent_cue\b[^\]\n]*\]\]/giu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
