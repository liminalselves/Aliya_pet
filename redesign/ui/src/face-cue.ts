/**
 * 动作脸部提示：动作播放期间按时间切换整套特殊眼型与替换嘴型。
 *
 * 模型里这些都是离散替换的网格（受击挤眼 Param33、哭眼 Param34、无语眼 Param35、
 * 鼓嘴 Param37、嘟嘴 Param39），中间值会让两套网格同时半透明叠在一起，
 * 所以不能写进 motion3.json 交给 SDK 交叉淡化，只能在最终写入点一帧切换。
 * 时间轴随动作资源一起放在 actions.json 的 face 字段（唯一来源）。
 */

export type FaceEye = 'hit' | 'sad' | 'speechless';
export type FaceMouth = 'puff' | 'pucker';

/** 一段脸部提示：[from, to) 秒内生效，时间相对动作开始。 */
export interface FaceCueSpan {
  from: number;
  to: number;
  eye?: FaceEye;
  mouth?: FaceMouth;
}

export interface FaceState {
  eye: FaceEye | null;
  mouth: FaceMouth | null;
}

const EYES: readonly string[] = ['hit', 'sad', 'speechless'];
const MOUTHS: readonly string[] = ['puff', 'pucker'];

/** 校验并规整 actions.json 里的 face 数组；格式不对的条目直接丢弃。 */
export function parseFaceCues(raw: unknown): FaceCueSpan[] {
  if (!Array.isArray(raw)) return [];
  const spans: FaceCueSpan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { from, to, eye, mouth } = item as Record<string, unknown>;
    if (typeof from !== 'number' || typeof to !== 'number' || !(to > from) || from < 0) continue;
    const span: FaceCueSpan = { from, to };
    if (typeof eye === 'string' && EYES.includes(eye)) span.eye = eye as FaceEye;
    if (typeof mouth === 'string' && MOUTHS.includes(mouth)) span.mouth = mouth as FaceMouth;
    if (span.eye || span.mouth) spans.push(span);
  }
  return spans.sort((a, b) => a.from - b.from);
}

/** 当前动作时间下应显示的眼型/嘴型；无提示返回全 null。 */
export function faceAt(spans: readonly FaceCueSpan[], t: number): FaceState {
  let eye: FaceEye | null = null;
  let mouth: FaceMouth | null = null;
  for (const s of spans) {
    if (t < s.from || t >= s.to) continue;
    if (s.eye) eye = s.eye;
    if (s.mouth) mouth = s.mouth;
  }
  return { eye, mouth };
}

/** 跟踪当前动作的脸部时间轴；打断、换动作或播完即清空。 */
export class FaceCueTrack {
  private _spans: readonly FaceCueSpan[] = [];
  private _t = 0;

  start(spans: readonly FaceCueSpan[]): void {
    this._spans = spans;
    this._t = 0;
  }

  stop(): void {
    this._spans = [];
    this._t = 0;
  }

  get active(): boolean {
    return this._spans.length > 0;
  }

  /** 推进时间并返回当前脸部状态；时间轴走完后自动停止。 */
  advance(dt: number): FaceState {
    if (this._spans.length === 0) return { eye: null, mouth: null };
    this._t += Math.max(0, Number.isFinite(dt) ? dt : 0);
    const state = faceAt(this._spans, this._t);
    if (this._spans.every((s) => this._t >= s.to)) this.stop();
    return state;
  }
}
