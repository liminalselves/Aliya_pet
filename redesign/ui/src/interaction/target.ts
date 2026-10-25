/**
 * 互动目标抽象（对应 Flutter InteractionTarget）：
 * 由 PetModel 实现，互动层只通过这组通道写入参数，不直接触碰模型。
 */

export interface InteractionParamInfo {
  angleXMin: number;
  angleXMax: number;
  angleYMin: number;
  angleYMax: number;
  angleZMin: number;
  angleZMax: number;
  bodyXMin: number;
  bodyXMax: number;
  eyeLMin: number;
  eyeLMax: number;
  eyeRMin: number;
  eyeRMax: number;
  hasEyes: boolean;
}

/** 抚摸恢复交给点击反应时，保留上一帧实际写入的姿态。 */
export interface InteractionPose {
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  eyeEnabled: boolean;
  eyeLeft: number;
  eyeRight: number;
}

export interface InteractionTarget {
  /** 模型互动参数范围；模型未就绪返回 null。 */
  getInteractionParamInfo(): InteractionParamInfo | null;

  /** 头部互动偏移（度，加性叠加在调度器输出之上）。 */
  setInteractionOffsets(
    angleX: number,
    angleY: number,
    angleZ: number,
    bodyAngleX: number
  ): void;

  /** 眼睛开合覆盖；side 仅接管指定眼睛，其余眼睛继续基础眨眼。 */
  setEyeOverride(
    enabled: boolean, leftOpen: number, rightOpen: number,
    side?: 'both' | 'left' | 'right'
  ): void;

  /** 猫耳附加偏移（参数缺失时静默忽略）。 */
  setEarInteraction(enabled: boolean, leftValue: number, rightValue: number): void;

  /** 脸红（ParamCheek 0..1，参数缺失时静默忽略）。 */
  setFaceCheek(enabled: boolean, value: number): void;

  /** 抚摸期间降低视线跟随权重。 */
  setPettingLookAtReduction(enabled: boolean): void;
}
