import type { PerformanceCue } from './types';

export interface PerformanceHost {
  expressions(): string[];
  actions(): string[];
  express(name: string): void;
  clearExpression(): void;
  play(name: string): void;
  busy(): boolean;
}

/** 短句触发表演。触碰优先；过时动作不排队，表情可在触碰后恢复。 */
export class ChatPerformance {
  private _expression: string | null = null;
  private _until = 0;
  private _applied = false;
  private _lastAction = -Infinity;

  constructor(private readonly host: PerformanceHost, private readonly now = () => performance.now()) {}

  get active(): boolean { return this._expression !== null && this.now() < this._until; }

  cue(cue: PerformanceCue): void {
    if (typeof cue.expression === 'string' && this.host.expressions().includes(cue.expression)) {
      this._expression = cue.expression;
      this._until = this.now() + 3500;
      this._applied = false;
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
    if (this.now() >= this._until) { this.cancel(); return; }
    if (this.host.busy()) {
      if (this._applied) this.host.clearExpression();
      this._applied = false;
    } else if (!this._applied) {
      this.host.express(this._expression);
      this._applied = true;
    }
  }

  cancel(): void {
    if (this._applied) this.host.clearExpression();
    this._expression = null;
    this._applied = false;
    this._until = 0;
  }
}
