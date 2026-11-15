/**
 * 情绪符号图层（ParamFx*：心、问号、惊叹、乌云、zzz、闪光、音符）。
 *
 * 每个符号由一个 0..1 参数驱动，模型里就是该图层的不透明度，可以平滑渐变；
 * 漂浮动效由物理（Param37/40/41）自动产生，这里只管出现与消失。
 *
 * 两个来源，同一时刻只显示一个符号：
 *   - 动作：actions.json 的 fx 时间轴，随动作播放；新动作接手即撤回（同脸部提示）。
 *   - 表情：切到对应表情时冒出一次，保持 EXPRESSION_FX_SECONDS 后淡出。
 * 动作时间轴里有符号时优先于表情。
 */

import type { CubismModel } from '@framework/model/cubismmodel';
import type { CubismIdHandle } from '@framework/id/cubismid';

export type FxName = 'heart' | 'question' | 'surprise' | 'gloom' | 'sleep' | 'sparkle' | 'music';

/** 符号名 → 模型参数。 */
export const FX_PARAMETERS: Readonly<Record<FxName, string>> = {
  heart: 'ParamFxHeart',
  question: 'ParamFxQuestion',
  surprise: 'ParamFxSurprise',
  gloom: 'ParamFxGloom',
  sleep: 'ParamFxSleep',
  sparkle: 'ParamFxSparkle',
  music: 'ParamFxMusic',
};

export const FX_NAMES = Object.keys(FX_PARAMETERS) as FxName[];

/** 表情名 → 切到该表情时冒出的符号。 */
export const EXPRESSION_FX: Readonly<Record<string, FxName>> = {
  happy: 'music',
  shy: 'heart',
  surprised: 'surprise',
  sad: 'gloom',
  gloomy: 'gloom',
  sleepy: 'sleep',
  smug: 'sparkle',
};

/** 表情符号保持时长（秒），之后淡出；表情本身继续。 */
export const EXPRESSION_FX_SECONDS = 2.6;

/** 一段动作符号：[from, to) 秒内显示，时间相对动作开始。 */
export interface FxSpan {
  from: number;
  to: number;
  fx: FxName;
}

/** 校验并规整 actions.json 里的 fx 数组；格式不对的条目直接丢弃。 */
export function parseFxCues(raw: unknown): FxSpan[] {
  if (!Array.isArray(raw)) return [];
  const spans: FxSpan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { from, to, fx } = item as Record<string, unknown>;
    if (typeof from !== 'number' || typeof to !== 'number' || !(to > from) || from < 0) continue;
    if (typeof fx !== 'string' || !(fx in FX_PARAMETERS)) continue;
    spans.push({ from, to, fx: fx as FxName });
  }
  return spans.sort((a, b) => a.from - b.from);
}

function fxAt(spans: readonly FxSpan[], t: number): FxName | null {
  let fx: FxName | null = null;
  for (const s of spans) if (t >= s.from && t < s.to) fx = s.fx;
  return fx;
}

/** 情绪符号通道：在物理之后写入 ParamFx*，渐入渐出。 */
export class FxChannel {
  readonly name = 'fx';
  private _spans: readonly FxSpan[] = [];
  private _t = 0;
  /** 重播衔接：旧时间轴正显示的符号在新时间轴同款区间开始前继续保持。 */
  private _hold: FxName | null = null;
  private _holdUntil = 0;
  private _expression: FxName | null = null;
  private _expressionLeft = 0;
  private readonly _level = new Map<FxName, number>();

  /** 渐入/渐出时长（秒）。 */
  static readonly IN_SECONDS = 0.25;
  static readonly OUT_SECONDS = 0.4;

  /** 只收模型里存在的参数；旧模型没有这些图层时整个通道不写入。 */
  constructor(private readonly ids: ReadonlyMap<FxName, CubismIdHandle>) {}

  /** 新动作接手：有 fx 时间轴则播放，没有则撤回动作符号（表情符号不受影响）。 */
  startAction(spans: readonly FxSpan[] | undefined): void {
    const showing = this._actionFx();
    const same = showing ? spans?.find((s) => s.fx === showing) : undefined;
    this._hold = same ? showing : null;
    this._holdUntil = same?.from ?? 0;
    this._spans = spans ?? [];
    this._t = 0;
  }

  /** 表情切换时调用：对应表情冒一次符号，其余表情撤回表情符号。 */
  setExpression(name: string | null): void {
    const fx = name ? EXPRESSION_FX[name] ?? null : null;
    this._expression = fx;
    this._expressionLeft = fx ? EXPRESSION_FX_SECONDS : 0;
  }

  /** 当前目标符号（调试/测试用）。 */
  get current(): FxName | null {
    return this._actionFx() ?? (this._expressionLeft > 0 ? this._expression : null);
  }

  private _actionFx(): FxName | null {
    if (this._spans.length === 0) return null;
    const fx = fxAt(this._spans, this._t);
    if (fx) return fx;
    return this._hold && this._t < this._holdUntil ? this._hold : null;
  }

  apply(model: CubismModel, dt: number): void {
    if (this.ids.size === 0) return;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    if (this._spans.length > 0) {
      this._t += step;
      if (this._hold && this._t >= this._holdUntil) this._hold = null;
      if (this._spans.every((s) => this._t >= s.to)) this._spans = [];
    }
    this._expressionLeft = Math.max(0, this._expressionLeft - step);

    const target = this.current;
    for (const [fx, id] of this.ids) {
      let level = this._level.get(fx) ?? 0;
      level = fx === target
        ? Math.min(1, level + step / FxChannel.IN_SECONDS)
        : Math.max(0, level - step / FxChannel.OUT_SECONDS);
      this._level.set(fx, level);
      model.setParameterValueById(id, level * level * (3 - 2 * level));
    }
  }
}
