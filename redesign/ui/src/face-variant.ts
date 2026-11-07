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
export const FACE_MOUTH_PARAMETERS = ['Param37', 'Param39'] as const;

/** 表情名对应的整套眼型（其余表情用普通眼睛）。 */
export function expressionEye(expression: string | null): FaceEye | null {
  return expression === 'hit' || expression === 'sad' || expression === 'speechless' ? expression : null;
}

/** 整套眼型是离散选择器，不能交叉淡化，也不能同时开启。 */
export function applyFaceVariant(
  model: CubismModel,
  ids: readonly CubismIdHandle[],
  eye: FaceEye | null
): void {
  model.setParameterValueById(ids[0], eye === 'hit' ? 1 : 0);
  model.setParameterValueById(ids[1], eye === 'sad' ? 1 : 0);
  model.setParameterValueById(ids[2], eye === 'speechless' ? 1 : 0);
  if (eye) {
    // 特殊眼型自带闭眼/半垂形状；普通眼睑与笑眼仍会裁掉这套网格。
    model.setParameterValueById(ids[3], 1);
    model.setParameterValueById(ids[4], 1);
    model.setParameterValueById(ids[5], 0);
    model.setParameterValueById(ids[6], 0);
    for (let i = 7; i < ids.length; i++) model.setParameterValueById(ids[i], 0);
  }
}

/**
 * 替换嘴型同样是 0/1 切换（中间值会让两张嘴半透明叠加）。
 * 受击挤眼自带整张脸，模型在 Param33 打开时会隐藏所有嘴；此时不再开替换嘴。
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
