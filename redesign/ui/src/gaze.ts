/**
 * GazeController —— 视线的唯一所有者（成熟路径重构）。
 *
 * 之前的问题：视线跟随 / 表情 exp3 眼球直写 / 动作注视曲线三套系统各自
 * 平滑、加性叠加、最后打钳制补丁——状态切换（空闲↔动作↔表情↔抚摸）时
 * 组合行为不可预测，出现瞬断、跳变、瞳孔越程露白。
 *
 * 现在的模型（单一管道，每帧固定四级）：
 *   目标(follow/0) → 目标平滑 → 动作交挖权重 → 写入(头部跟随 + 眼球跟随
 *   + 表情注视偏移[仅眼] → 总钳制)
 *
 * 所有权规则（写眼球的只有这里与动作曲线；动作播放时跟随权重淡出，
 * 动作曲线独占）：
 *   动作 > 表情偏移 > 指针跟随；抚摸期间跟随增益 ×0.25。
 *
 * 性能：无每帧分配，全部标量字段复用。
 */

import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismModel } from '@framework/model/cubismmodel';
import { CubismLook } from '@framework/effect/cubismlook';

/**
 * 表情注视偏移（眼睛-only，度，±30 量程）。
 * exp3.json 不再直写眼球——偏移在这里与指针跟随合成、统一平滑与钳制。
 * 设计要点：sad/sleepy 垂眼、shy/worried 回避视线、smug 斜眼、
 * surprised 上瞟、angry 下压瞪视——是表情差异化的主要来源之一。
 */
export const EXPRESSION_GAZE: Record<string, readonly [number, number]> = {
  happy: [0, 2],
  angry: [0, -6],
  sad: [0, -8],
  surprised: [0, 4],
  shy: [6, -5],
  sleepy: [0, -7],
  smug: [5, 0],
  speechless: [0, -3],
  worried: [-5, 2],
  serious: [0, 0],
  hit: [0, 0],
};

export interface GazeUpdateOptions {
  /** 动作播放中（视线跟随交挖，动作注视曲线独占）。 */
  motionActive: boolean;
  /** 跟随增益乘数（抚摸期间 0.25）。 */
  reduction: number;
}

export class GazeController {
  private readonly _look: CubismLook;
  private readonly _idEyeBallX: CubismIdHandle;
  private readonly _idEyeBallY: CubismIdHandle;

  // 指针/AI 目标（-1..1，右/上为正；不活跃时回中）
  private _targetX = 0;
  private _targetY = 0;
  private _active = false;

  // 平滑后的跟随输出与交挖权重
  private _x = 0;
  private _y = 0;
  private _weight = 1;

  // 表情注视偏移（独立平滑，切表情时交叉淡化）
  private _exprX = 0;
  private _exprY = 0;
  private _exprTargetX = 0;
  private _exprTargetY = 0;

  /** 眼球安全行程（±30 量程的 2/3，超出后瞳孔滑出眼白「变白」）。 */
  public static readonly EYE_LIMIT = 20;

  private static readonly TAU_SECONDS = 0.12; // 指针目标平滑
  private static readonly WEIGHT_TAU_SECONDS = 0.22; // 动作交挖淡化
  private static readonly EXPRESSION_TAU_SECONDS = 0.45; // 表情偏移淡化

  constructor(
    look: CubismLook,
    idEyeBallX: CubismIdHandle,
    idEyeBallY: CubismIdHandle
  ) {
    this._look = look;
    this._idEyeBallX = idEyeBallX;
    this._idEyeBallY = idEyeBallY;
  }

  /** 设置注视目标（0..1 归一，y 向上为正；来自指针/AI）。 */
  setTarget(x01: number, y01: number): void {
    this._targetX = Math.min(Math.max(x01 * 2 - 1, -1), 1);
    this._targetY = Math.min(Math.max(y01 * 2 - 1, -1), 1);
    this._active = true;
  }

  /** 清除目标（平滑回中后停止跟随）。 */
  clearTarget(): void {
    this._active = false;
  }

  /** 当前是否有跟随目标（诊断用）。 */
  get active(): boolean {
    return this._active;
  }

  /**
   * 设置表情注视偏移（表情切换时调用；null/未知表情回零）。
   * 偏移只作用于眼球，头部不受表情影响（避免与动作/跟随叠加）。
   */
  setExpression(name: string | null): void {
    const g = name ? EXPRESSION_GAZE[name] : undefined;
    this._exprTargetX = g ? g[0] : 0;
    this._exprTargetY = g ? g[1] : 0;
  }

  /** 每帧求值（物理之后、model.update 之前调用）。 */
  update(model: CubismModel, dt: number, opts: GazeUpdateOptions): void {
    // 1) 动作交挖权重（平滑淡入淡出，杜绝瞬断）
    const weightTarget = opts.motionActive ? 0 : 1;
    this._weight +=
      (weightTarget - this._weight) *
      (1 - Math.exp(-dt / GazeController.WEIGHT_TAU_SECONDS));

    // 2) 指针目标平滑（无目标时回中）
    const tx = this._active ? this._targetX : 0;
    const ty = this._active ? this._targetY : 0;
    const k = 1 - Math.exp(-dt / GazeController.TAU_SECONDS);
    this._x += (tx - this._x) * k;
    this._y += (ty - this._y) * k;

    // 3) 表情偏移平滑
    const ke = 1 - Math.exp(-dt / GazeController.EXPRESSION_TAU_SECONDS);
    this._exprX += (this._exprTargetX - this._exprX) * ke;
    this._exprY += (this._exprTargetY - this._exprY) * ke;

    // 4) 写入：头部跟随（CubismLook 增益：AngleX 12 / AngleY 10 /
    //    AngleZ 角落 -8 / BodyAngleX 4 / 眼球 18）——输入已含权重
    const followX = this._x * this._weight * opts.reduction;
    const followY = this._y * this._weight * opts.reduction;
    this._look.updateParameters(model, followX, followY);

    // 5) 眼球：叠加表情偏移（仅眼）→ 总钳制（跟随 18×follow + 偏移，
    //    与动作注视曲线的交挖瞬态都在安全行程内）
    if (Math.abs(this._exprX) > 0.01 || Math.abs(this._exprY) > 0.01) {
      model.addParameterValueById(this._idEyeBallX, this._exprX);
      model.addParameterValueById(this._idEyeBallY, this._exprY);
    }
    const limit = GazeController.EYE_LIMIT;
    const bx = model.getParameterValueById(this._idEyeBallX);
    if (bx > limit || bx < -limit) {
      model.setParameterValueById(
        this._idEyeBallX,
        bx > limit ? limit : -limit
      );
    }
    const by = model.getParameterValueById(this._idEyeBallY);
    if (by > limit || by < -limit) {
      model.setParameterValueById(
        this._idEyeBallY,
        by > limit ? limit : -limit
      );
    }
  }
}
