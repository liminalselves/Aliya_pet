/**
 * 台词系统（移植自 Flutter 版，逻辑等价）：
 *   - 场景文件加载（/dialogue/*.json）
 *   - 动态变量：{player_year}/{aliya_year}（Aliya 与玩家相差 1000 年）等
 *   - 分页：反斜杠人工分页符优先，否则按标点/词智能分页
 *   - 抽取：shuffle_bag 洗牌袋（一轮内不重复）、tag 分组袋、minRepeatDays 冷却
 */

export interface DialogueEntry {
  id?: string;
  text?: string;
  weight?: number;
  tags?: string[];
  minRepeatDays?: number;
  enabled?: boolean;
  /** 运行时：上次抽取时间（epoch ms） */
  lastSelectedDate?: number;
}

export interface DialogueFile {
  characterId: string;
  scene: string;
  selectionMode?: string;
  singlePageMaxChars?: number;
  maxPages?: number;
  entries: DialogueEntry[];
}

export interface DialoguePage {
  index: number;
  text: string;
}

export interface ResolvedDialogue {
  entryId: string;
  finalText: string;
  pages: DialoguePage[];
}

// ---------- 时间场景 ----------

const SCENE_LABELS: Record<string, string> = {
  morning: '早晨',
  forenoon: '上午',
  lunch: '午间',
  afternoon: '下午',
  dinner: '晚餐',
  evening: '傍晚',
  late_night: '深夜',
  deep_night: '深夜',
};

/** 按本地时间返回时段场景名（05:00~07:59 morning … 00:00~04:59 deep_night）。 */
export function timeScene(now: Date): string {
  const m = now.getHours() * 60 + now.getMinutes();
  if (m >= 300 && m <= 479) return 'morning';
  if (m >= 480 && m <= 659) return 'forenoon';
  if (m >= 660 && m <= 839) return 'lunch';
  if (m >= 840 && m <= 1019) return 'afternoon';
  if (m >= 1020 && m <= 1139) return 'dinner';
  if (m >= 1140 && m <= 1319) return 'evening';
  return m >= 1320 ? 'late_night' : 'deep_night';
}

export function periodLabel(now: Date): string {
  return SCENE_LABELS[timeScene(now)] ?? '深夜';
}

// ---------- 变量解析 ----------

const VARIABLE_PATTERN = /\{[a-zA-Z_]+\}/g;

export function resolveVariables(text: string, now: Date): string {
  if (!text) return text;
  const pad = (n: number) => String(n).padStart(2, '0');
  const result = text
    .replaceAll('{player_year}', String(now.getFullYear()))
    .replaceAll('{aliya_year}', String(now.getFullYear() + 1000))
    .replaceAll('{current_month}', pad(now.getMonth() + 1))
    .replaceAll('{current_day}', pad(now.getDate()))
    .replaceAll('{current_time}', `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replaceAll('{time_period}', periodLabel(now));
  // 未识别的变量直接抹掉（与 Flutter 版一致）
  return result.replace(VARIABLE_PATTERN, '');
}

// ---------- 分页 ----------

const PUNCTUATION = new Set('，。？！、；：…～·?!,;:.'.split(''));
const DEFAULT_SINGLE_PAGE_MAX_CHARS = 18;
const DEFAULT_MAX_PAGES = 3;

interface Unit {
  text: string;
  isPunct: boolean;
}

function isWordChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39)
  );
}

function tokenize(text: string): Unit[] {
  const result: Unit[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (PUNCTUATION.has(c)) {
      result.push({ text: c, isPunct: true });
      i++;
      continue;
    }
    if (isWordChar(c)) {
      const start = i;
      while (i < text.length && isWordChar(text[i])) i++;
      result.push({ text: text.substring(start, i), isPunct: false });
      continue;
    }
    result.push({ text: c, isPunct: false });
    i++;
  }
  return result;
}

function joinUnits(units: Unit[], start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < units.length; i++) s += units[i].text;
  return s.trim();
}

function pack(units: Unit[], target: number): string[] {
  const pages: string[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i;
    let chars = 0;
    let lastBreak = -1;
    while (j < units.length) {
      const u = units[j];
      if (chars + u.text.length > target) break;
      chars += u.text.length;
      if (u.isPunct) lastBreak = j + 1;
      j++;
    }

    if (j >= units.length) {
      pages.push(joinUnits(units, i, units.length));
      break;
    }

    let cut: number;
    if (lastBreak > i && lastBreak <= j) {
      cut = lastBreak;
    } else if (units[j].isPunct && chars + units[j].text.length <= target + 2) {
      cut = j + 1; // 吸收标点到本页末尾，避免下一页以标点开头
    } else {
      cut = j;
    }
    if (cut <= i) cut = i + 1; // 单个单元超限时整体成页，防死循环

    pages.push(joinUnits(units, i, cut));
    i = cut;
  }
  const cleaned = pages.filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : [''];
}

function rebalance(text: string, target: number, maxPages: number): string[] {
  const units = tokenize(text);
  const totalChars = units.reduce((acc, u) => acc + u.text.length, 0);
  const perPage = Math.max(1, Math.ceil(totalChars / maxPages));
  const pages = pack(units, perPage);
  while (pages.length > maxPages && pages.length > 1) {
    pages[pages.length - 2] = pages[pages.length - 2] + pages[pages.length - 1];
    pages.pop();
  }
  return pages;
}

export function paginate(
  text: string,
  singlePageMaxChars?: number,
  maxPages?: number
): DialoguePage[] {
  const target = Math.max(1, singlePageMaxChars ?? DEFAULT_SINGLE_PAGE_MAX_CHARS);
  const maxP = Math.max(1, maxPages ?? DEFAULT_MAX_PAGES);

  if (!text.trim()) return [{ index: 0, text: '' }];

  // 人工分页符优先
  const explicit = text
    .split('\\')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (explicit.length > 1) {
    const texts =
      explicit.length <= maxP
        ? explicit
        : rebalance(explicit.join(''), target, maxP);
    return texts.map((t, i) => ({ index: i, text: t }));
  }

  const units = tokenize(text);
  let texts = pack(units, target);
  if (texts.length > maxP) texts = rebalance(text, target, maxP);
  return texts.map((t, i) => ({ index: i, text: t }));
}

// ---------- 仓库 + 抽取 ----------

const SCENE_URLS: Record<string, string> = {
  user_click: '/dialogue/user_click.json',
  head_petting: '/dialogue/head_petting.json',
  morning: '/dialogue/time/morning.json',
  forenoon: '/dialogue/time/forenoon.json',
  lunch: '/dialogue/time/lunch.json',
  afternoon: '/dialogue/time/afternoon.json',
  dinner: '/dialogue/time/dinner.json',
  evening: '/dialogue/time/evening.json',
  late_night: '/dialogue/time/late_night.json',
  deep_night: '/dialogue/time/deep_night.json',
};

const DAY_MS = 24 * 3600 * 1000;

export class DialogueStore {
  private _files = new Map<string, DialogueFile>();
  private _bags = new Map<string, DialogueEntry[]>();
  private _tagBags = new Map<string, DialogueEntry[]>();

  async loadAll(): Promise<void> {
    const entries = Object.entries(SCENE_URLS);
    await Promise.all(
      entries.map(async ([scene, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const file = (await res.json()) as DialogueFile;
          this._files.set(scene, file);
        } catch {
          // 场景文件缺失：该场景静默无台词
        }
      })
    );
  }

  findScene(scene: string): DialogueFile | undefined {
    return this._files.get(scene);
  }

  private _candidates(scene: string): DialogueEntry[] {
    return (this._files.get(scene)?.entries ?? []).filter(
      (e) => e.enabled !== false && !!e.text?.trim()
    );
  }

  private _applyCooldown(entries: DialogueEntry[], now: number): DialogueEntry[] {
    const available = entries.filter(
      (e) =>
        !e.minRepeatDays ||
        e.minRepeatDays <= 0 ||
        !e.lastSelectedDate ||
        now - e.lastSelectedDate >= e.minRepeatDays * DAY_MS
    );
    if (available.length > 0) return available;
    // 全部冷却中：优先冷却最久的
    return [...entries].sort(
      (a, b) => (a.lastSelectedDate ?? 0) - (b.lastSelectedDate ?? 0)
    );
  }

  private _buildBag(available: DialogueEntry[], weightBoost = 0): DialogueEntry[] {
    const hasWeight =
      available.some((e) => (e.weight ?? 0) > 0) || weightBoost > 0;
    if (!hasWeight) {
      const list = [...available];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }
    // 加权不重复：反复按权重抽取并移除
    const weight = (e: DialogueEntry) =>
      Math.max(0.01, (e.weight ?? 1.0) * (1.0 + weightBoost));
    const remaining = [...available];
    const result: DialogueEntry[] = [];
    while (remaining.length > 0) {
      const total = remaining.reduce((s, e) => s + weight(e), 0);
      const roll = Math.random() * total;
      let acc = 0;
      let pick = remaining.length - 1;
      for (let i = 0; i < remaining.length; i++) {
        acc += weight(remaining[i]);
        if (roll <= acc) {
          pick = i;
          break;
        }
      }
      result.push(remaining.splice(pick, 1)[0]);
    }
    return result;
  }

  /** 按场景抽取一条（洗牌袋 / 加权）。 */
  select(scene: string): DialogueEntry {
    const candidates = this._candidates(scene);
    const now = Date.now();
    if (candidates.length === 0) {
      return { id: 'fallback', text: '今天也一起加油吧。', enabled: true };
    }
    const available = this._applyCooldown(candidates, now);

    let entry: DialogueEntry;
    if (this._files.get(scene)?.selectionMode?.toLowerCase() === 'shuffle_bag') {
      let bag = this._bags.get(scene);
      if (!bag || bag.length === 0) {
        bag = this._buildBag(available);
        this._bags.set(scene, bag);
      }
      entry = bag.shift()!;
    } else {
      entry = this._weightedPick(available);
    }
    entry.lastSelectedDate = now;
    return entry;
  }

  /** 按场景 + tag 抽取（抚摸台词分组）。 */
  selectByTag(
    scene: string,
    tag: string,
    excludeIds?: Set<string>,
    weightBoost = 0
  ): DialogueEntry | null {
    let entries = this._candidates(scene).filter((e) =>
      e.tags?.includes(tag)
    );
    if (entries.length === 0) return null;
    if (excludeIds && excludeIds.size > 0) {
      const filtered = entries.filter(
        (e) => !e.id || !excludeIds.has(e.id)
      );
      if (filtered.length > 0) entries = filtered;
    }
    const now = Date.now();
    const available = this._applyCooldown(entries, now);

    const bagKey = `${scene}:${tag}`;
    let bag = this._tagBags.get(bagKey);
    if (!bag || bag.length === 0) {
      bag = this._buildBag(available, weightBoost);
      this._tagBags.set(bagKey, bag);
    }
    const entry = bag.shift()!;
    entry.lastSelectedDate = now;
    return entry;
  }

  private _weightedPick(available: DialogueEntry[]): DialogueEntry {
    const hasWeight = available.some((e) => (e.weight ?? 0) > 0);
    if (!hasWeight) {
      return available[Math.floor(Math.random() * available.length)];
    }
    const total = available.reduce(
      (s, e) => s + Math.max(0.01, e.weight ?? 1.0),
      0
    );
    const roll = Math.random() * total;
    let acc = 0;
    for (const e of available) {
      acc += Math.max(0.01, e.weight ?? 1.0);
      if (roll <= acc) return e;
    }
    return available[available.length - 1];
  }

  /** 从全部场景的有效台词中随机抽取一条（随机说话用）。 */
  selectRandom(): DialogueEntry | null {
    const all: DialogueEntry[] = [];
    for (const scene of this._files.keys()) {
      all.push(...this._candidates(scene));
    }
    if (all.length === 0) return null;
    const now = Date.now();
    const available = this._applyCooldown(all, now);
    const entry = this._weightedPick(available);
    entry.lastSelectedDate = now;
    return entry;
  }

  /** 随机解析一条（默认分页配置）。 */
  resolveRandom(): ResolvedDialogue | null {
    const entry = this.selectRandom();
    if (!entry) return null;
    return this.resolveEntry(entry);
  }

  /** 解析一条完整台词：变量替换 + 分页。 */
  resolveEntry(
    entry: DialogueEntry,
    maxChars?: number,
    maxPages?: number
  ): ResolvedDialogue | null {
    const text = entry.text;
    if (!text || !text.trim()) return null;
    const finalText = resolveVariables(text, new Date());
    if (!finalText.trim()) return null;
    const pages = paginate(finalText, maxChars, maxPages);
    if (pages.length === 0) return null;
    return { entryId: entry.id ?? '', finalText, pages };
  }

  resolveScene(scene: string): ResolvedDialogue | null {
    const entry = this.select(scene);
    const file = this._files.get(scene);
    return this.resolveEntry(entry, file?.singlePageMaxChars, file?.maxPages);
  }

  resolveSceneTag(
    scene: string,
    tag: string,
    excludeIds?: Set<string>,
    weightBoost = 0
  ): ResolvedDialogue | null {
    const entry = this.selectByTag(scene, tag, excludeIds, weightBoost);
    if (!entry) return null;
    const file = this._files.get(scene);
    return this.resolveEntry(entry, file?.singlePageMaxChars, file?.maxPages);
  }
}
