import type { CubismModel } from '@framework/model/cubismmodel';
import type { CubismIdHandle } from '@framework/id/cubismid';
import type { FaceEye, FaceMouth } from './face-cue';

export const FACE_VARIANT_PARAMETERS = [
  'Param33', 'Param34', 'Param35', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeBallX', 'ParamEyeBallY',
  // 普通眼珠、眼眶和高光的弹性变形不能作用到整套替换眼睛。
  'Param', 'Param2', 'Param3', 'Param15', 'Param16', 'Param17', 'Param19', 'Param20',
  'Param18', 'Param21', 'Param23', 'Param22', 'Param24', 'Param25', 'Param26', 'Param27',
  'Param28', 'Param29',
] as const;

/** 替换嘴型：鼓嘴、嘟嘴。打开时原嘴三张网格整体隐藏。 */
export const FACE_MOUTH_PARAMETERS = ['Param38', 'Param39'] as const;

/** 表情名对应的整套眼型（其余表情用普通眼睛）。 */
export function expressionEye(expression: string | null): FaceEye | null {
  return expression === 'hit' || expression === 'sad' || expression === 'speechless' ? expression : null;
}

/**
 * 整套眼型选择器互斥开启。weight 只用于流泪/无语在闭眼状态下的 0→1 过渡；
 * mute 是眼球与普通眼部物理归零的程度（过渡中平滑变化，避免一帧跳变）。
 * 两者默认 1，即直接完整显示。
 */
export function applyFaceVariant(
  model: CubismModel,
  ids: readonly CubismIdHandle[],
  eye: FaceEye | null,
  weight = 1,
  mute = eye ? 1 : 0
): void {
  model.setParameterValueById(ids[0], eye === 'hit' ? 1 : 0);
  model.setParameterValueById(ids[1], eye === 'sad' ? weight : 0);
  model.setParameterValueById(ids[2], eye === 'speechless' ? weight : 0);
  // 眼球与普通眼部弹性变形也会带动整套替换眼睛：特殊眼期间归零，进出时按 mute 渐变。
  if (mute >= 1) {
    for (let i = 7; i < ids.length; i++) model.setParameterValueById(ids[i], 0);
  } else if (mute > 0) {
    for (let i = 7; i < ids.length; i++) {
      model.setParameterValueById(ids[i], model.getParameterValueById(ids[i]) * (1 - mute));
    }
  }
  // 特殊眼期间普通眼保持闭合（眼睑由调用方的过渡值写入），笑眼归零。
  // 新版模型中眼睑不再裁切特殊眼网格，但它仍是猫耳物理输入：保持恒定才不会晃耳。
  if (eye && weight >= 1) {
    model.setParameterValueById(ids[5], 0);
    model.setParameterValueById(ids[6], 0);
  }
}
/**
 * 替换嘴型同样是 0/1 切换（中间值会让两张嘴半透明叠加）。
 * 受击挤眼（Param33）期间原嘴保持显示并随 ParamMouthOpenY 开合；此时不再开替换嘴，避免叠嘴。
 */
export function applyFaceMouth(
  model: CubismModel,
  ids: readonly CubismIdHandle[],
  mouth: FaceMouth | null,
  eye: FaceEye | null
): void {
  const m = eye === 'hit' ? null : mouth;
  model.setParameterValueById(ids[0], m === 'puff' ? 1 : 0);
  model.setParameterValueById(ids[1], m === 'pucker' ? 1 : 0);
}

/** 可在闭眼状态下 0→1 渐变的眼型（画师按此过渡制作）；受击仍是 0/1 切换。 */
function fadeable(eye: FaceEye | null): boolean {
  return eye === 'sad' || eye === 'speechless';
}

const smooth = (k: number) => k * k * (3 - 2 * k);

/**
 * 特殊眼型切换过渡。
 *
 * 流泪（Param34）/无语（Param35）：两只眼先一起闭上，闭眼状态下选择器
 * 0→1 渐变完成换眼；离开时反过来，闭眼下 1→0，再睁开普通眼。两者互切时
 * 先淡出旧的再淡入新的，眼睛全程闭着。受击（Param33）在闭眼后一帧切换。
 *
 * 顺滑要点：EyeOpen 同时是猫耳、眼眶等物理的输入，任何跳变或多余的开合都会
 * 让猫耳弹一下（看起来就是眼睛抖）。所以特殊眼期间普通眼睑一直保持闭合，
 * 只有进入前闭一次、离开后睁一次；眼球与眼部物理的归零程度（mute）同样渐变。
 *
 * 用法：每帧把目标眼型与当前真实眼睑值传进 advance，用返回的 eye/weight/mute
 * 调 applyFaceVariant，lid 非 null 时再覆盖写 EyeLOpen/ROpen。
 */
export class EyeVariantTransition {
  /** 当前显示的眼型。 */
  private _eye: FaceEye | null = null;
  /** 可渐变眼型的显现程度 0..1；其余眼型恒为 1。 */
  private _weight = 1;
  /** 普通眼睑被强制闭合的程度 0..1。 */
  private _close = 0;
  /** 眼球/眼部物理归零程度 0..1。 */
  private _mute = 0;

  /** 闭眼段。 */
  static readonly CLOSE_SECONDS = 0.12;
  /** 闭眼下选择器 0↔1 渐变段。 */
  static readonly FADE_SECONDS = 0.32;
  /** 睁眼段。 */
  static readonly OPEN_SECONDS = 0.18;

  /** 当前是否有特殊眼型显示或正在闭眼过渡中。 */
  get active(): boolean {
    return this._eye !== null || this._close > 0;
  }

  /**
   * @param target 本帧目标眼型（face cue 或表情推导）
   * @param dt 帧间隔秒
   * @param lid 未被本类覆盖的真实眼睑值（眨眼/动作/互动合成后）
   * @param holdClosed 退出特殊眼型后若新动作即将闭眼，暂缓睁眼避免多余眨眼
   */
  advance(
    target: FaceEye | null,
    dt: number,
    lid: number,
    holdClosed = false
  ): { eye: FaceEye | null; weight: number; mute: number; lid: number | null } {
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const C = EyeVariantTransition;
    const closeBy = (seconds: number) => { this._close = Math.min(1, this._close + step / seconds); };
    const openBy = (seconds: number) => { this._close = Math.max(0, this._close - step / seconds); };

    if (target !== this._eye) {
      // 外部眼睑本就已全闭时无需再等 CLOSE_SECONDS，直接进入选择器淡变。
      if (this._eye === null && lid <= 0.02) this._close = 1;
      // 先（可见或隐藏地）闭上普通眼睑，闭到底才动选择器。
      if (this._close < 1) closeBy(C.CLOSE_SECONDS);
      else if (fadeable(this._eye) && this._weight > 0) {
        this._weight = Math.max(0, this._weight - step / C.FADE_SECONDS);
      } else {
        this._eye = target;
        this._weight = fadeable(target) ? 0 : 1;
      }
    } else if (fadeable(this._eye) && this._weight < 1) {
      this._weight = Math.min(1, this._weight + step / C.FADE_SECONDS);
    } else if (this._eye === null) {
      if (!holdClosed) openBy(C.OPEN_SECONDS);
    } else {
      // 特殊眼期间眼睑一直闭着：不做隐藏的睁开/再闭合，猫耳物理输入保持不变。
      this._close = 1;
    }

    const special = this._eye !== null || target !== null;
    this._mute = special
      ? Math.min(1, this._mute + step / C.CLOSE_SECONDS)
      : Math.max(0, this._mute - step / C.OPEN_SECONDS);

    return {
      eye: this._eye,
      weight: fadeable(this._eye) ? smooth(this._weight) : 1,
      mute: smooth(this._mute),
      lid: this._close > 0 ? Math.min(1, Math.max(0, lid)) * (1 - smooth(this._close)) : null,
    };
  }
}