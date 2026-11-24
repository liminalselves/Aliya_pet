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
  bodyYMin?: number;
  bodyYMax?: number;
  bodyZMin?: number;
  bodyZMax?: number;
  eyeLMin: number;
  eyeLMax: number;
  eyeRMin: number;
  eyeRMax: number;
  hasEyes: boolean;
}

export interface ArmInteractionValues {
  armL01: number;
  armL02: number;
  armR01: number;
  armR02: number;
}

export interface FaceMicroInteractionValues {
  eyeSmile?: number;
  mouthForm?: number;
  mouthOpen?: number;
  browY?: number;
  browAngle?: number;
  browForm?: number;
}

export type PartImpulseKind =
  | 'tie'
  | 'bangs'
  | 'side_hair_left'
  | 'side_hair_right'
  | 'ponytail'
  | 'hair_bounce'
  | 'hand_left'
  | 'hand_right'
  | 'ear_left'
  | 'ear_right';

/** 抚摸恢复交给点击反应时，保留上一帧实际写入的姿态。 */
export interface InteractionPose {
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  bodyY?: number;
  bodyZ?: number;
  eyeEnabled: boolean;
  eyeLeft: number;
  eyeRight: number;
  earL?: number;
  earR?: number;
  cheek?: number;
  arms?: ArmInteractionValues;
  faceMicro?: FaceMicroInteractionValues;
}

export interface InteractionTarget {
  /** 模型互动参数范围；模型未就绪返回 null。 */
  getInteractionParamInfo(): InteractionParamInfo | null;

  /** 头部互动偏移（度，加性叠加在调度器输出之上，在物理之前写入）。 */
  setInteractionOffsets(
    angleX: number,
    angleY: number,
    angleZ: number,
    bodyAngleX: number
  ): void;

  /** 身体俯仰与侧倾偏移（度，加性叠加在物理之前，可选）。 */
  setBodyTilt?(bodyAngleY: number, bodyAngleZ: number): void;

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

  /** 四腕互动偏移（±10 量程，参数缺失时静默忽略）。 */
  setArmInteraction?(enabled: boolean, values?: Partial<ArmInteractionValues>): void;

  /** 面部微表情（笑眼/嘴角/张嘴/眉部，参数缺失时静默忽略）。 */
  setFaceMicroInteraction?(enabled: boolean, values?: FaceMicroInteractionValues): void;

  /** 对局部物理链或发丝施加一次阻尼弹簧触碰脉冲。 */
  triggerPartImpulse?(part: PartImpulseKind, strength: number): void;
}
