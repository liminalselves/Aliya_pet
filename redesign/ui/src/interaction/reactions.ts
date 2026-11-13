/**
 * 互动反应组（assets/interaction/reactions.json，docs/INTERACTION.md）。
 * 反应组 = 一组气泡台词 + 一个表情和/或一个动作，三者同时触发；组内多条台词共用同一套表演。
 * 触发键（click.head、petting.start、time.morning、random…）映射到若干反应组，每次抽一组。
 */

import { ACTION_BY_NAME, EXPRESSION_BY_NAME } from '../catalog';
import { DialogueStore, type DialogueEntry, type ResolvedDialogue } from '../dialogue/dialogue';
import { assetUrl } from '../embed';

export interface ReactionGroup {
  id: string;
  /** 临时表情（播完回到当前状态的默认表情）。 */
  expression?: string;
  /** 动作（catalog.ts 的 motion 或 procedural）。 */
  action?: string;
  /** procedural 动作强度（缺省用该微动的默认值）。 */
  strength?: number;
  lines: DialogueEntry[];
}

export interface ReactionsFile {
  singlePageMaxChars?: number;
  maxPages?: number;
  groups: ReactionGroup[];
  triggers: Record<string, string[]>;
}

export interface ReactionPick {
  group: ReactionGroup;
  /** 要说的台词；只要表演不要台词时为 null。 */
  line: ResolvedDialogue | null;
}

/** 校验并规整数据；不合格的组与引用直接丢弃，问题列表供控制台警告与测试。 */
export function validateReactions(raw: unknown): { file: ReactionsFile; problems: string[] } {
  const problems: string[] = [];
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReactionsFile>;
  const groups = new Map<string, ReactionGroup>();
  for (const g of Array.isArray(doc.groups) ? doc.groups : []) {
    const id = typeof g?.id === 'string' ? g.id : '';
    if (!id || groups.has(id)) { problems.push(`组 id 缺失或重复：${id}`); continue; }
    const lines = (Array.isArray(g.lines) ? g.lines : []).filter(l => typeof l?.text === 'string' && l.text.trim());
    if (lines.length === 0) { problems.push(`${id}：没有台词`); continue; }
    if (!g.expression && !g.action) { problems.push(`${id}：表情和动作至少要有一个`); continue; }
    if (g.expression && !EXPRESSION_BY_NAME.has(g.expression)) { problems.push(`${id}：未知表情 ${g.expression}`); continue; }
    if (g.action && !ACTION_BY_NAME.has(g.action)) { problems.push(`${id}：未知动作 ${g.action}`); continue; }
    groups.set(id, { ...g, id, lines });
  }
  const triggers: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(doc.triggers ?? {})) {
    const valid = (Array.isArray(ids) ? ids : []).filter(id => {
      if (groups.has(id)) return true;
      problems.push(`触发键 ${key}：引用了不存在的组 ${id}`);
      return false;
    });
    if (valid.length > 0) triggers[key] = valid;
  }
  return {
    file: { singlePageMaxChars: doc.singlePageMaxChars, maxPages: doc.maxPages, groups: [...groups.values()], triggers },
    problems,
  };
}

export class ReactionLibrary {
  private readonly _store = new DialogueStore();
  private _groups = new Map<string, ReactionGroup>();
  private _triggers: Record<string, string[]> = {};
  private readonly _lastGroup = new Map<string, string>();

  constructor(private readonly random: () => number = Math.random) {}

  async load(url = assetUrl('/interaction/reactions.json')): Promise<void> {
    try {
      const res = await fetch(url);
      if (res.ok) this.setData(await res.json());
    } catch {
      // 数据缺失：互动只剩无台词的基础反馈
    }
  }

  setData(raw: unknown): void {
    const { file, problems } = validateReactions(raw);
    for (const p of problems) console.warn(`[reactions] ${p}`);
    this._groups = new Map(file.groups.map(g => [g.id, g]));
    this._triggers = file.triggers;
    this._lastGroup.clear();
    for (const g of file.groups) {
      this._store.setScene(g.id, { singlePageMaxChars: file.singlePageMaxChars, maxPages: file.maxPages, entries: g.lines });
    }
  }

  /** 停用带指定标签的台词（隐藏猫耳时的 ears）；整组台词都被停用的组不再被抽到。 */
  setExcludedTags(tags: Iterable<string>): void {
    this._store.setExcludedTags(tags);
  }

  /** 触发键下当前可用台词总数（随机台词按它在多个触发键间分配概率）。 */
  lineCount(trigger: string): number {
    return this._available(trigger).reduce((n, g) => n + this._store.candidates(g.id).length, 0);
  }

  has(trigger: string): boolean {
    return this._available(trigger).length > 0;
  }

  /**
   * 抽一个反应组；同一触发键尽量不连续抽到同一组。
   * withLine=false 时不消耗台词（台词位被占用时只做表演）。
   */
  pick(trigger: string, opts: { withLine?: boolean; excludeIds?: Set<string> } = {}): ReactionPick | null {
    let groups = this._available(trigger);
    if (groups.length === 0) return null;
    const last = this._lastGroup.get(trigger);
    if (groups.length > 1 && last) groups = groups.filter(g => g.id !== last);
    const group = groups[Math.min(groups.length - 1, Math.floor(this.random() * groups.length))];
    this._lastGroup.set(trigger, group.id);
    const line = opts.withLine === false ? null : this._store.resolveScene(group.id, opts.excludeIds);
    return { group, line };
  }

  private _available(trigger: string): ReactionGroup[] {
    return (this._triggers[trigger] ?? [])
      .map(id => this._groups.get(id))
      .filter((g): g is ReactionGroup => !!g && this._store.candidates(g.id).length > 0);
  }
}
