import type { CubismModel } from '@framework/model/cubismmodel';
import type { CubismIdHandle } from '@framework/id/cubismid';

export const FACE_VARIANT_PARAMETERS = [
  'Param33', 'Param34', 'Param35', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeBallX', 'ParamEyeBallY',
  // 普通眼珠、眼眶和高光的弹性变形不能作用到整套替换眼睛。
  'Param', 'Param2', 'Param3', 'Param15', 'Param16', 'Param17', 'Param19', 'Param20',
  'Param18', 'Param21', 'Param23', 'Param22', 'Param24', 'Param25', 'Param26', 'Param27',
  'Param28', 'Param29',
] as const;

/** 整套眼型是离散选择器，不能交叉淡化，也不能同时开启。 */
export function applyFaceVariant(
  model: CubismModel,
  ids: readonly CubismIdHandle[],
  expression: string | null
): void {
  model.setParameterValueById(ids[0], expression === 'hit' ? 1 : 0);
  model.setParameterValueById(ids[1], expression === 'sad' ? 1 : 0);
  model.setParameterValueById(ids[2], expression === 'speechless' ? 1 : 0);
  if (expression === 'hit' || expression === 'speechless' || expression === 'sad') {
    // 特殊眼型自带闭眼/半垂形状；普通眼睑与笑眼仍会裁掉这套网格。
    model.setParameterValueById(ids[3], 1);
    model.setParameterValueById(ids[4], 1);
    model.setParameterValueById(ids[5], 0);
    model.setParameterValueById(ids[6], 0);
    for (let i = 7; i < ids.length; i++) model.setParameterValueById(ids[i], 0);
  }
}
