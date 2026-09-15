/**
 * 正则显示规则：移植 misskey agent-session.message.vue 的 displayContent 行为
 * 与后端 AgentService.normalizeRegexRules 的清洗逻辑。
 * 规则来自 agents/characters/show；只有 targets 命中消息角色且 effects 含 hide
 * 的规则参与展示过滤，aiInvisible 只影响 LLM 上下文。
 */
import type { AgentRegexRule, ChatRole, MskApiCaller } from './types';

/** 与权威端一致：按数组顺序串行替换，flags 固定 'gu'，非法 pattern 静默跳过。 */
export function applyDisplayRules(content: string, rules: ReadonlyArray<AgentRegexRule> | undefined, role: ChatRole): string {
  let result = content ?? '';
  for (const rule of rules ?? []) {
    if (!rule || typeof rule.pattern !== 'string' || rule.pattern === '') continue;
    if (!rule.targets?.includes(role) || !rule.effects?.includes('hide')) continue;
    try {
      result = result.replace(new RegExp(rule.pattern, 'gu'), '');
    } catch {
      // 非法规则在客户端同样忽略。
    }
  }
  return result;
}

function pickStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 与后端 normalizeRegexRules 一致：缺字段、targets/effects 为空、pattern 编译失败的规则丢弃，最多 64 条。 */
export function normalizeRegexRules(raw: unknown): AgentRegexRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentRegexRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.pattern !== 'string' || value.pattern === '') continue;
    const targets = pickStrings(value.targets).filter(v => v === 'user' || v === 'assistant');
    const effects = pickStrings(value.effects).filter(v => v === 'hide' || v === 'aiInvisible');
    if (targets.length === 0 || effects.length === 0) continue;
    try {
      new RegExp(value.pattern, 'gu');
    } catch {
      continue;
    }
    out.push({ id: value.id, pattern: value.pattern, targets, effects });
    if (out.length >= 64) break;
  }
  return out;
}

/** 拉取角色的正则规则（agents/characters/show 始终下发规则内容，与提示词隐私无关）。 */
export async function fetchRegexRules(api: MskApiCaller, characterId: string, signal?: AbortSignal): Promise<AgentRegexRule[]> {
  const data = await api<{ regexRules?: unknown }>('agents/characters/show', { characterId }, signal);
  return normalizeRegexRules(data?.regexRules);
}
