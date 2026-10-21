/**
 * 情绪引擎：桌宠的持续心境状态机。
 *
 * 分层（自下而上叠加）：物理/待机（呼吸眨眼视线）→ 动作（motion3.json，
 * 瞬时行为）→ 表情（exp3.json，持续心境的可见面）→ 互动反应。
 *
 * 情绪驱动三件事：
 *   1. 默认表情（切换时交叉淡入淡出）
 *   2. 自动动作的抽取权重（开心时更爱挥手，困时更爱打哈欠）
 *   3. 对外事件（pet:mood），AI 可据此组织语言/行为
 *
 * 情绪会自然衰减回 neutral（每档独立半衰），也可指定持续时间。
 */

/** 情绪定义。expression 为 null 表示中性（清除表情）。 */
export interface MoodDefinition {
  /** 对应表情名（exp3.json），null = 无表情。 */
  expression: string | null;
  /** 自然持续时间（秒），到时回 neutral；Infinity = 不自动衰减。 */
  durationSeconds: number;
  /** 自动动作权重加成：动作名 → 倍率（1 = 不变）。 */
  actionBias: Record<string, number>;
}

export const MOODS: Record<string, MoodDefinition> = {
  neutral: {
    expression: null,
    durationSeconds: Infinity,
    actionBias: {},
  },
  happy: {
    expression: 'happy',
    durationSeconds: 10 * 60,
    actionBias: { wave: 3, sway: 2, stretch: 1.5 },
  },
  cheerful: {
    // 高兴的弱档：不换表情，只影响动作选择（供 AI 表达「还不错」）
    expression: null,
    durationSeconds: 8 * 60,
    actionBias: { sway: 2, nod: 1.5 },
  },
  angry: {
    expression: 'angry',
    durationSeconds: 4 * 60,
    actionBias: { angry: 3.5, shake: 2 },
  },
  sad: {
    expression: 'sad',
    durationSeconds: 8 * 60,
    actionBias: { sway: 2.5 },
  },
  shy: {
    expression: 'shy',
    durationSeconds: 5 * 60,
    actionBias: { nod: 2.5, wave: 1.2 },
  },
  sleepy: {
    expression: 'sleepy',
    durationSeconds: 10 * 60,
    actionBias: { yawn: 3.5, stretch: 2 },
  },
  smug: {
    expression: 'smug',
    durationSeconds: 5 * 60,
    actionBias: { sway: 2, nod: 1.5 },
  },
  curious: {
    expression: null,
    durationSeconds: 5 * 60,
    actionBias: { doubt: 3 },
  },
  speechless: {
    expression: 'speechless',
    durationSeconds: 3 * 60,
    actionBias: { doubt: 2 },
  },
};

export interface MoodState {
  name: string;
  /** 已持续秒数。 */
  elapsedSeconds: number;
}

export interface MoodHost {
  startExpression(name: string | null): boolean;
}

/** 情绪变化监听（pet:mood 事件同载荷）。 */
export type MoodListener = (mood: MoodState, previous: string) => void;

export class MoodEngine {
  private readonly _host: MoodHost;
  private _name = 'neutral';
  private _elapsed = 0;
  private _duration = Infinity;
  private readonly _listeners = new Set<MoodListener>();

  constructor(host: MoodHost) {
    this._host = host;
  }

  get current(): MoodState {
    return { name: this._name, elapsedSeconds: this._elapsed };
  }

  onMoodChanged(listener: MoodListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * 设置情绪。
   * @param name MOODS 键名（未知键返回 false）
   * @param durationSeconds 覆盖持续时间（可选）
   */
  setMood(name: string, durationSeconds?: number): boolean {
    const def = MOODS[name];
    if (!def) return false;
    const previous = this._name;
    this._name = name;
    this._elapsed = 0;
    this._duration = durationSeconds ?? def.durationSeconds;
    this._host.startExpression(def.expression);
    if (previous !== name) {
      for (const l of this._listeners) {
        try {
          l(this.current, previous);
        } catch {
          // 监听器异常不影响状态机
        }
      }
    }
    return true;
  }

  /** 每帧推进：到时自然回落 neutral。 */
  tick(deltaTimeSeconds: number): void {
    if (this._name === 'neutral') return;
    this._elapsed += deltaTimeSeconds;
    if (this._elapsed >= this._duration) {
      this.setMood('neutral');
    }
  }

  /**
   * 情绪对动作抽取的权重加成。
   * @returns 动作名 → 倍率（缺省 1）
   */
  actionWeights(): Record<string, number> {
    return MOODS[this._name]?.actionBias ?? {};
  }
}
