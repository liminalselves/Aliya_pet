/**
 * 状态引擎：桌宠稳定保持的「默认表情 + 待机动作池」（定义见 catalog.ts STATES）。
 * 手动选择优先并一直保持，选回「自动」后按时段决定：深夜/凌晨困倦，其余平静。
 * MSK 不干预状态；聊天表情、互动表情都只是临时覆盖，结束后回到状态默认表情。
 */

import { STATE_BY_NAME, type StateDef } from './catalog';
import { timeScene } from './dialogue/dialogue';

export interface StateHost {
  startExpression(name: string | null): boolean;
}

export interface StateSnapshot {
  /** 当前生效的状态名。 */
  name: string;
  /** 手动选择；null = 自动。 */
  manual: string | null;
}

export type StateListener = (state: StateSnapshot, previous: string) => void;

/** 自动规则：只看本地时段。 */
export function autoStateAt(now: Date): string {
  const scene = timeScene(now);
  return scene === 'late_night' || scene === 'deep_night' ? 'sleepy' : 'neutral';
}

export class StateEngine {
  private _manual: string | null = null;
  private _name: string;
  private readonly _listeners = new Set<StateListener>();

  constructor(private readonly host: StateHost, private readonly now = () => new Date()) {
    this._name = autoStateAt(this.now());
    this.host.startExpression(this.definition.expression);
  }

  get current(): StateSnapshot {
    return { name: this._name, manual: this._manual };
  }

  get definition(): StateDef {
    return STATE_BY_NAME.get(this._name) ?? STATE_BY_NAME.get('neutral')!;
  }

  onChanged(listener: StateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** 手动指定状态；null 回到自动。未知名返回 false。 */
  setManual(name: string | null): boolean {
    if (name !== null && !STATE_BY_NAME.has(name)) return false;
    this._manual = name;
    this._apply(name ?? autoStateAt(this.now()), true);
    return true;
  }

  /** 定时调用：自动模式下跟随时段切换。 */
  tick(): void {
    if (this._manual === null) this._apply(autoStateAt(this.now()), false);
  }

  /** manual=true 时即使状态没变也重新套用默认表情（手动选择要能盖掉临时表情）。 */
  private _apply(name: string, manual: boolean): void {
    const previous = this._name;
    if (previous === name && !manual) return;
    this._name = name;
    this.host.startExpression(this.definition.expression);
    for (const listener of this._listeners) {
      try { listener(this.current, previous); } catch { /* 监听器异常不影响状态机 */ }
    }
  }
}
