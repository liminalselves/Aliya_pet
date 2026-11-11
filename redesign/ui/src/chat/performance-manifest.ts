/**
 * 表演能力清单与 [[agent_cue]] 指令解析。
 * 清单由 catalog.ts 派生（全部表情 + Live2D 动作；互动专用的程序微动与状态不上报），
 * 随聊天请求上报——服务端把「携带清单」识别为桌宠环境并注入表演协议（docs/PERFORMANCE.md）。
 */
import { ACTIONS, EXPRESSIONS } from '../catalog';
import type { PerformanceCue } from './types';

export interface PerformanceItem {
  name: string;
  hint: string;
}

export const PERFORMANCE_EXPRESSIONS: readonly PerformanceItem[] =
  EXPRESSIONS.map(({ name, hint }) => ({ name, hint }));

export const PERFORMANCE_ACTIONS: readonly PerformanceItem[] =
  ACTIONS.filter(a => a.kind === 'motion').map(({ name, hint }) => ({ name, hint }));

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
