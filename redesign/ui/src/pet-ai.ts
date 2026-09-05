/**
 * PetAI —— 桌宠对外控制 API（AI / 自动化 / 调试入口）。
 *
 * 挂载在 window.petAI（浏览器壳/WebView 壳可直接调用；Tauri 壳可经
 * evaluate 脚本调用，后续可包一层 Tauri command）。所有能力均基于
 * 语义名（表情/动作/情绪），不暴露底层 Live2D 参数。
 *
 * 事件总线：所有变更以 CustomEvent 派发到 window，事件名 'pet:*'：
 *   pet:mood       { detail: { mood, previous } }
 *   pet:expression { detail: { expression } }
 *   pet:action     { detail: { action } }
 * AI 侧可 addEventListener 监听宠物状态，配合状态查询做闭环。
 */

import { MoodEngine, MOODS } from './emotion';
import type { PetModel } from './pet-model';

export interface PetAIDeps {
  model: () => PetModel | null;
  moodEngine: () => MoodEngine | null;
  playAction: (name: string) => boolean;
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
   * 播放表情（叠加在动作之上，交叉淡入淡出）。
   * @param name 表情名（expressions() 之一）
   * @param durationSeconds 可选：到时自动回到当前情绪的默认表情
   */
  express(name: string, durationSeconds?: number): boolean {
    const model = this._deps.model();
    if (!model) return false;
    if (!model.startExpression(name)) return false;
    this._emit('pet:expression', { expression: name });
    if (this._tempExpressionTimer) {
      clearTimeout(this._tempExpressionTimer);
      this._tempExpressionTimer = null;
    }
    if (typeof durationSeconds === 'number' && durationSeconds > 0) {
      this._tempExpressionTimer = setTimeout(() => {
        this._tempExpressionTimer = null;
        const mood = this._deps.moodEngine()?.current.name ?? 'neutral';
        const back = MOODS[mood]?.expression ?? null;
        if (model.startExpression(back)) {
          this._emit('pet:expression', { expression: back });
        }
      }, durationSeconds * 1000);
    }
    return true;
  }

  /** 清除临时表情，回到当前情绪默认。 */
  clearExpression(): void {
    const mood = this._deps.moodEngine()?.current.name ?? 'neutral';
    const back = MOODS[mood]?.expression ?? null;
    if (this._deps.model()?.startExpression(back)) {
      this._emit('pet:expression', { expression: back });
    }
    if (this._tempExpressionTimer) {
      clearTimeout(this._tempExpressionTimer);
      this._tempExpressionTimer = null;
    }
  }

  // ---------- 情绪 ----------

  /** 情绪列表与定义（含动作亲和）。 */
  moods(): typeof MOODS {
    return MOODS;
  }

  /** 设置情绪（切默认表情 + 影响自动动作选择；到时自然回落 neutral）。 */
  setMood(name: string, durationSeconds?: number): boolean {
    const engine = this._deps.moodEngine();
    if (!engine) return false;
    const previous = engine.current.name;
    if (!engine.setMood(name, durationSeconds)) return false;
    this._emit('pet:mood', { mood: name, previous });
    return true;
  }

  /** 当前情绪。 */
  mood(): { name: string; elapsedSeconds: number } {
    return this._deps.moodEngine()?.current ?? { name: 'neutral', elapsedSeconds: 0 };
  }

  // ---------- 动作 ----------

  /** 播放动作（可被后续动作打断；挥手自动联动抬手）。 */
  play(name: string): boolean {
    const ok = this._deps.playAction(name);
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
    const model = this._deps.model();
    if (!model) return;
    model.setLookTarget((x + 1) / 2, (y + 1) / 2);
  }

  /** 视线回中（恢复跟随指针）。 */
  clearGaze(): void {
    this._deps.model()?.clearLookTarget();
  }

  // ---------- 状态 ----------

  /** 快照（AI 上下文）。 */
  state(): {
    mood: string;
    expression: string | null;
    expressions: string[];
    actions: string[];
  } {
    const model = this._deps.model();
    return {
      mood: this.mood().name,
      expression: model?.getCurrentExpression() ?? null,
      expressions: model?.getExpressionNames() ?? [],
      actions: model?.actionManifest?.map((a) => a.name) ?? [],
    };
  }

  private _emit(type: string, detail: unknown): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }
}
