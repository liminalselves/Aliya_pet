import type { PerformanceCue } from './types';

export interface PerformanceHost {
  expressions(): string[];
  actions(): string[];
  /** 当前实际表情（null = 情绪默认）；提供时用于情绪引擎覆盖后重新拿回聊天表情。 */
  expression?(): string | null;
  express(name: string): void;
  clearExpression(): void;
  play(name: string): void;
  busy(): boolean;
}

/** AI 指令驱动的聊天表演（docs/PERFORMANCE.md）：表情持久直到下一个指令或取消、
 *  动作只播一次且限频；触碰/拖动优先，结束后恢复聊天表情。 */
export class ChatPerformance {
  private _expression: string | null = null;
  private _applied = false;
  private _lastAction = -Infinity;

  constructor(private readonly host: PerformanceHost, private readonly now = () => performance.now()) {}

  get active(): boolean { return this._expression !== null; }

  cue(cue: PerformanceCue): void {
    if (typeof cue.expression === 'string' && this.host.expressions().includes(cue.expression)) {
      // 幂等：AI 偶尔对保持中的表情重复切换，不重放 express
      if (this._expression !== cue.expression) {
        this._expression = cue.expression;
        this._applied = false;
      }
    }
    if (!this.host.busy() && this.now() - this._lastAction >= 4000 &&
        typeof cue.action === 'string' && this.host.actions().includes(cue.action)) {
      this.host.play(cue.action);
      this._lastAction = this.now();
    }
    this.tick();
  }

  tick(): void {
    if (!this._expression) return;
    if (this.host.busy()) {
      if (this._applied) this.host.clearExpression();
      this._applied = false;
      return;
    }
    // host.expression 可用时按实际表情比对：情绪引擎/手动预览覆盖后每帧拿回；
    // 不可用时退回 _applied 标记（busy 结束后恢复）。
    const current = this.host.expression?.();
    if (current !== undefined ? current !== this._expression : !this._applied) {
      this.host.express(this._expression);
      this._applied = true;
    }
  }

  cancel(): void {
    if (this._applied) this.host.clearExpression();
    this._expression = null;
    this._applied = false;
  }
}
