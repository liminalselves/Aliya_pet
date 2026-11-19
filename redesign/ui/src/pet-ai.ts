/**
 * PetAI —— 桌宠对外控制 API（AI / 自动化 / 调试入口）。
 *
 * 挂载在 window.petAI（浏览器壳/WebView 壳可直接调用；Tauri 壳可经
 * evaluate 脚本调用）。三个概念见 catalog.ts：表情、动作、状态。
 *
 * 事件总线：所有变更以 CustomEvent 派发到 window，事件名 'pet:*'：
 *   pet:state      { detail: { state, manual, previous } }
 *   pet:expression { detail: { expression } }
 *   pet:action     { detail: { action } }
 */

import { STATES, type StateDef } from './catalog';
import type { StateEngine } from './state';
import type { PetModel } from './pet-model';

export interface PetAIDeps {
  model: () => PetModel | null;
  stateEngine: () => StateEngine | null;
  /** 播放动作（motion 与 procedural 都经此入口）。 */
  playAction: (name: string, opts?: { areaId?: string; side?: number }) => boolean;
  /** 可播放的动作名。 */
  actionNames: () => string[];
  /** 当前互动/说话/暂停状态（可选）。 */
  coordinationState?: () => { interacting: boolean; speaking: boolean; paused: boolean };
  /** 指针是否已释放视线（可选）。 */
  gazeReleased?: () => boolean;
  /** 当日有效抚摸次数（可选）。 */
  headPettingCountToday?: () => number;
}

export class PetAI {
  private readonly _deps: PetAIDeps;
  private _tempExpressionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PetAIDeps) {
    this._deps = deps;
  }

  // ---------- 表情 ----------

  /** 可用表情名列表。 */
  expressions(): string[] {
    return this._deps.model()?.getExpressionNames() ?? [];
  }

  /**
   * 临时切换表情（交叉淡入淡出）。
   * @param durationSeconds 可选：到时自动回到当前状态的默认表情
   */
  express(name: string, durationSeconds?: number): boolean {
    const model = this._deps.model();
    if (!model) return false;
    if (!model.startExpression(name)) return false;
    this._emit('pet:expression', { expression: name });
    this._clearTimer();
    if (typeof durationSeconds === 'number' && durationSeconds > 0) {
      this._tempExpressionTimer = setTimeout(() => {
        this._tempExpressionTimer = null;
        this.clearExpression();
      }, durationSeconds * 1000);
    }
    return true;
  }

  /** 清除临时表情，回到当前状态的默认表情。 */
  clearExpression(): void {
    this._clearTimer();
    const back = this._deps.stateEngine()?.definition.expression ?? null;
    if (this._deps.model()?.startExpression(back)) {
      this._emit('pet:expression', { expression: back });
    }
  }

  // ---------- 状态 ----------

  /** 状态定义（默认表情 + 待机动作池）。 */
  states(): readonly StateDef[] {
    return STATES;
  }

  /** 手动指定状态；null 回到自动。 */
  setState(name: string | null): boolean {
    return this._deps.stateEngine()?.setManual(name) ?? false;
  }

  // ---------- 动作 ----------

  /** 播放动作（可被后续动作打断；支持传递 procedural 方位参数）。 */
  play(name: string, opts?: { areaId?: string; side?: number }): boolean {
    const ok = this._deps.playAction(name, opts);
    if (ok) this._emit('pet:action', { action: name });
    return ok;
  }

  // ---------- 视线 ----------

  /**
   * 注视目标（AI 引导注意力，如看向弹幕/对话气泡）。
   * @param x -1..1（右为正）
   * @param y -1..1（上为正）
   */
  gaze(x: number, y: number): void {
    this._deps.model()?.setLookTarget((x + 1) / 2, (y + 1) / 2);
  }

  /** 视线回中（恢复跟随指针）。 */
  clearGaze(): void {
    this._deps.model()?.clearLookTarget();
  }

  // ---------- 状态快照 ----------

  /** 快照（AI 上下文）。 */
  state(): {
    state: string;
    manual: string | null;
    expression: string | null;
    expressions: string[];
    actions: string[];
    interacting: boolean;
    speaking: boolean;
    gazeReleased: boolean;
    headPettingCountToday: number;
  } {
    const current = this._deps.stateEngine()?.current ?? { name: 'neutral', manual: null };
    const coord = this._deps.coordinationState?.() ?? { interacting: false, speaking: false, paused: false };
    return {
      state: current.name,
      manual: current.manual,
      expression: this._deps.model()?.getCurrentExpression() ?? null,
      expressions: this.expressions(),
      actions: this._deps.actionNames(),
      interacting: coord.interacting,
      speaking: coord.speaking,
      gazeReleased: this._deps.gazeReleased?.() ?? false,
      headPettingCountToday: this._deps.headPettingCountToday?.() ?? 0,
    };
  }

  /** 状态引擎变化时由宿主转发。 */
  emitState(state: string, manual: string | null, previous: string): void {
    this._emit('pet:state', { state, manual, previous });
  }

  /** 互动事件总线（click / petting / drag），供外部 AI/插件观察。 */
  emitInteraction(detail: unknown): void {
    this._emit('pet:interaction', detail);
  }

  /** 外部临时表情变更同步（确保互动临时表情也发出 pet:expression 并取消旧定时）。 */
  emitExpression(expression: string | null): void {
    this._emit('pet:expression', { expression });
  }

  cancelExpressionTimer(): void {
    this._clearTimer();
  }

  private _clearTimer(): void {
    if (this._tempExpressionTimer) clearTimeout(this._tempExpressionTimer);
    this._tempExpressionTimer = null;
  }

  private _emit(type: string, detail: unknown): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }
}
