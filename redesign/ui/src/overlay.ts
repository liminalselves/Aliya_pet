/**
 * OverlayLayer —— 程序化覆盖通道（物理之后、model.update 之前的写入层）。
 *
 * 把原先散落在 pet-model.update 里的内联块（互动头部偏移/眼睛覆盖/猫耳/
 * 脸红/抬手）收敛为显式通道：每个通道自包含、无相互依赖，固定顺序应用。
 * 写入点唯一约束：此处晚于物理求值，因此可以直接加写物理输出参数
 * （猫耳 Param9/13、手部五段链）当帧生效。
 *
 * 性能：通道为预建对象，update 无分配。
 */

import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismModel } from '@framework/model/cubismmodel';
import type { PartImpulseKind } from './interaction/target';

export interface OverlayChannel {
  readonly name: string;
  apply(model: CubismModel, dt: number): void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const addClamped = (model: CubismModel, id: CubismIdHandle | undefined, delta: number, min: number, max: number) => {
  if (!id || delta === 0) return;
  const next = clamp(model.getParameterValueById(id) + delta, min, max);
  model.setParameterValueById(id, next);
};

/** 互动层（抚摸/点击/拎起）的头部与身体偏移——在物理前加性写入，带出头发与配饰物理。 */
export class InteractionOffsetChannel implements OverlayChannel {
  readonly name = 'interaction-offset';
  angleX = 0;
  angleY = 0;
  angleZ = 0;
  bodyX = 0;
  bodyY = 0;
  bodyZ = 0;
  constructor(
    private readonly ids: {
      angleX: CubismIdHandle;
      angleY: CubismIdHandle;
      angleZ: CubismIdHandle;
      bodyAngleX: CubismIdHandle;
      bodyAngleY?: CubismIdHandle;
      bodyAngleZ?: CubismIdHandle;
    }
  ) {}
  private readonly _values = [0, 0, 0, 0, 0, 0];
  apply(model: CubismModel, dt = 1 / 60): void {
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const k = step > 0 ? 1 - Math.exp(-step / 0.06) : 1;
    // 从点击交给抚摸、失焦回中时也从当前偏移继续，不清零跳帧。
    const targets = [
      Number.isFinite(this.angleX) ? this.angleX : 0,
      Number.isFinite(this.angleY) ? this.angleY : 0,
      Number.isFinite(this.angleZ) ? this.angleZ : 0,
      Number.isFinite(this.bodyX) ? this.bodyX : 0,
      Number.isFinite(this.bodyY) ? this.bodyY : 0,
      Number.isFinite(this.bodyZ) ? this.bodyZ : 0,
    ];
    for (let i = 0; i < 6; i++) {
      this._values[i] += (targets[i] - this._values[i]) * k;
      if (Math.abs(this._values[i]) < 0.0001) this._values[i] = 0;
    }
    if (this._values[0] !== 0) model.addParameterValueById(this.ids.angleX, this._values[0]);
    if (this._values[1] !== 0) model.addParameterValueById(this.ids.angleY, this._values[1]);
    if (this._values[2] !== 0) model.addParameterValueById(this.ids.angleZ, this._values[2]);
    if (this._values[3] !== 0) model.addParameterValueById(this.ids.bodyAngleX, this._values[3]);
    if (this._values[4] !== 0 && this.ids.bodyAngleY) {
      model.addParameterValueById(this.ids.bodyAngleY, this._values[4]);
    }
    if (this._values[5] !== 0 && this.ids.bodyAngleZ) {
      model.addParameterValueById(this.ids.bodyAngleZ, this._values[5]);
    }
  }
}

interface EyeHandoff {
  active: boolean;
  elapsed: number;
  from: number;
  value: number | null;
}

/** 每只眼睛独立接管及释放，未接管侧完全不写入。 */
export class EyeOverrideChannel implements OverlayChannel {
  readonly name = 'eye-override';
  private _enabled = false;
  get enabled(): boolean { return this._enabled; }
  set enabled(value: boolean) {
    if (this._enabled && !value) {
      // 同一帧先取消旧控制器、再由新控制器接管，也必须重新交接。
      for (const state of [this._left, this._right]) {
        if (!state.active) continue;
        state.from = state.value ?? 1;
        state.active = false;
        state.elapsed = 0;
      }
    }
    this._enabled = value;
  }
  side: 'both' | 'left' | 'right' = 'both';
  left = 1;
  right = 1;
  private readonly _left: EyeHandoff = { active: false, elapsed: 1, from: 1, value: null };
  private readonly _right: EyeHandoff = { active: false, elapsed: 1, from: 1, value: null };
  constructor(
    private readonly ids: { left: CubismIdHandle; right: CubismIdHandle }
  ) {}
  apply(model: CubismModel, dt = 1 / 60): void {
    dt = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this._applyEye(model, this.ids.left, this._left,
      this.enabled && this.side !== 'right', this.left, dt);
    this._applyEye(model, this.ids.right, this._right,
      this.enabled && this.side !== 'left', this.right, dt);
  }
  private _applyEye(model: CubismModel, id: CubismIdHandle, state: EyeHandoff,
    active: boolean, target: number, dt: number): void {
    const base = model.getParameterValueById(id);
    if (active !== state.active) {
      state.from = state.value ?? base;
      state.elapsed = 0;
      state.active = active;
    }
    if (active || state.elapsed < 0.18) {
      const duration = active ? 0.1 : 0.18;
      state.elapsed = Math.min(state.elapsed + dt, duration);
      const t = Math.min(state.elapsed / duration, 1);
      const k = t * t * (3 - 2 * t);
      state.value = state.from + ((active ? target : base) - state.from) * k;
      model.setParameterValueById(id, state.value);
    } else {
      state.value = base;
    }
  }
}

/** 猫耳互动：新版写 Param8/9/10（左）与 Param12/13/14（右）旋转+晃动，旧版保留 ParamEarL/R。 */
export class EarChannel implements OverlayChannel {
  readonly name = 'ear';
  enabled = false;
  visible = true;
  left = 0;
  right = 0;
  scale = 1;
  private _curL = 0;
  private _curR = 0;
  constructor(
    private readonly ids: {
      left: CubismIdHandle;
      right: CubismIdHandle;
      leftRot?: CubismIdHandle;
      leftTip?: CubismIdHandle;
      rightRot?: CubismIdHandle;
      rightTip?: CubismIdHandle;
    }
  ) {}
  apply(model: CubismModel, dt = 1 / 60): void {
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const active = this.enabled && this.visible;
    const targetL = active && Number.isFinite(this.left) ? clamp(this.left, -1, 1) : 0;
    const targetR = active && Number.isFinite(this.right) ? clamp(this.right, -1, 1) : 0;
    const tau = active ? 0.065 : 0.10;
    const k = step > 0 ? 1 - Math.exp(-step / tau) : 1;
    this._curL += (targetL - this._curL) * k;
    this._curR += (targetR - this._curR) * k;
    if (Math.abs(this._curL) < 0.0005) this._curL = 0;
    if (Math.abs(this._curR) < 0.0005) this._curR = 0;
    if (this._curL === 0 && this._curR === 0) return;

    if (this.ids.leftRot || this.ids.rightRot) {
      addClamped(model, this.ids.leftRot, this._curL * 0.85, -1, 1);
      addClamped(model, this.ids.left, this._curL * 0.65, -1, 1);
      addClamped(model, this.ids.leftTip, this._curL * 0.45, -1, 1);
      addClamped(model, this.ids.rightRot, this._curR * 0.85, -1, 1);
      addClamped(model, this.ids.right, this._curR * 0.65, -1, 1);
      addClamped(model, this.ids.rightTip, this._curR * 0.45, -1, 1);
      return;
    }
    if (this._curL !== 0) model.addParameterValueById(this.ids.left, this._curL * this.scale);
    if (this._curR !== 0) model.addParameterValueById(this.ids.right, this._curR * this.scale);
  }
}

class EarSpringChain {
  p0 = 0; v0 = 0;
  p1 = 0; v1 = 0;
  p2 = 0; v2 = 0;
  private readonly _w1: number;
  private readonly _w2: number;

  constructor(private readonly _w0: number, private readonly _z0: number) {
    this._w1 = _w0 * 1.12;
    this._w2 = _w0 * 1.02;
  }

  reset(): void {
    this.p0 = this.v0 = this.p1 = this.v1 = this.p2 = this.v2 = 0;
  }

  energy(): number {
    return Math.abs(this.p0) + Math.abs(this.v0) * 0.06
      + Math.abs(this.p1) + Math.abs(this.v1) * 0.06
      + Math.abs(this.p2) + Math.abs(this.v2) * 0.06;
  }

  step(dt: number, target: number, accelKick: number): void {
    // Node 0（耳根主旋转）：外力目标 + 起步/急停加速度冲击
    const a0 = this._w0 * this._w0 * (target - this.p0) - 2 * this._z0 * this._w0 * this.v0 + accelKick;
    this.v0 += a0 * dt;
    this.p0 += this.v0 * dt;

    // Node 1（耳中段）与 Node 2（耳尖）：逐级跟随并带鞭梢滞后
    const t1 = this.p0 * 0.96 - this.v0 * 0.012;
    const a1 = this._w1 * this._w1 * (t1 - this.p1) - 2 * 0.38 * this._w1 * this.v1;
    this.v1 += a1 * dt;
    this.p1 += this.v1 * dt;

    const t2 = this.p1 * 0.98 - this.v1 * 0.015;
    const a2 = this._w2 * this._w2 * (t2 - this.p2) - 2 * 0.36 * this._w2 * this.v2;
    this.v2 += a2 * dt;
    this.p2 += this.v2 * dt;
  }
}

export interface EarDragPhysicsIds {
  leftRot: CubismIdHandle;
  leftMid: CubismIdHandle;
  leftTip: CubismIdHandle;
  leftPersp?: CubismIdHandle;
  rightRot: CubismIdHandle;
  rightMid: CubismIdHandle;
  rightTip: CubismIdHandle;
  rightPersp?: CubismIdHandle;
}

/**
 * 拖拽期间猫耳 3 段耦合弹簧物理：
 * 分别模拟耳根→中段→耳尖的相位滞后、加速度惯性冲击与停手回弹，
 * 接管并修正原 aliya.physics3.json PhysicsSetting9 在水平风力下的反偏问题。
 */
export class EarDragPhysics {
  visible = true;
  reducedMotion = false;

  private _windX = 0;
  private _windY = 0;
  private _prevWindX = 0;
  private _prevWindY = 0;
  private _blend = 0;
  // left = 解剖左耳（画面右耳 Param8/9/10），right = 解剖右耳（画面左耳 Param12/13/14）；
  // 两侧固有频率略错开 6%，避免双耳同步镜像。
  private readonly _left = new EarSpringChain(15.0, 0.34);
  private readonly _right = new EarSpringChain(14.1, 0.33);

  constructor(private readonly ids: EarDragPhysicsIds) {}

  setWind(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this._windX = clamp(x, -1.2, 1.2);
    this._windY = clamp(y, -1.2, 1.2);
  }

  apply(model: CubismModel, dt = 1 / 60): void {
    if (!this.visible || this.reducedMotion) {
      this._windX = this._windY = this._prevWindX = this._prevWindY = this._blend = 0;
      this._left.reset();
      this._right.reset();
      return;
    }

    const total = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const hasWind = Math.abs(this._windX) > 0.001 || Math.abs(this._windY) > 0.001;
    let energy = Math.max(this._left.energy(), this._right.energy());
    if (!hasWind && this._blend === 0 && energy < 0.001) return;

    if (total > 0) {
      const dwx = clamp((this._windX - this._prevWindX) / total, -12, 12);
      const dwy = clamp((this._windY - this._prevWindY) / total, -12, 12);
      this._prevWindX = this._windX;
      this._prevWindY = this._windY;

      const tLeft = 0.92 * Math.tanh(-this._windX * 1.15 + this._windY * 0.72);
      const tRight = 0.92 * Math.tanh(this._windX * 1.22 + this._windY * 0.72);
      const kickLeft = -dwx * 5.0 + dwy * 3.2;
      const kickRight = dwx * 5.2 + dwy * 3.2;

      const n = Math.max(1, Math.ceil(total / (1 / 60)));
      const h = total / n;
      for (let i = 0; i < n; i++) {
        this._left.step(h, tLeft, kickLeft);
        this._right.step(h, tRight, kickRight);
      }
      energy = Math.max(this._left.energy(), this._right.energy());
    }

    const active = hasWind || energy > 0.02;
    const blendTarget = active ? 1 : 0;
    const tau = active ? 0.05 : 0.22;
    const bk = total > 0 ? 1 - Math.exp(-total / tau) : 1;
    this._blend += (blendTarget - this._blend) * bk;
    if (!active && this._blend < 0.001) {
      this._blend = 0;
      if (energy < 0.005) {
        this._left.reset();
        this._right.reset();
      }
      return;
    }

    const b = this._blend;
    const write = (id: CubismIdHandle | undefined, val: number) => {
      if (!id) return;
      const cur = model.getParameterValueById(id);
      model.setParameterValueById(id, clamp(cur * (1 - b) + val * b, -1, 1));
    };

    const lRot = Math.tanh(this._left.p0);
    const lMid = Math.tanh(this._left.p1);
    const lTip = Math.tanh(this._left.p2);
    const rRot = Math.tanh(this._right.p0);
    const rMid = Math.tanh(this._right.p1);
    const rTip = Math.tanh(this._right.p2);

    write(this.ids.leftRot, lRot);
    write(this.ids.leftMid, lMid);
    write(this.ids.leftTip, lTip);
    write(this.ids.leftPersp, clamp(lRot * 0.35, -1, 1));

    write(this.ids.rightRot, rRot);
    write(this.ids.rightMid, rMid);
    write(this.ids.rightTip, rTip);
    write(this.ids.rightPersp, clamp(rRot * 0.35, -1, 1));
  }
}

/** 四腕互动通道（ParamArmL01/02, R01/02）；挥手切换腕部图层时左臂自动让位。 */
export class ArmInteractionChannel implements OverlayChannel {
  readonly name = 'arm-interaction';
  enabled = false;
  armL01 = 0;
  armL02 = 0;
  armR01 = 0;
  armR02 = 0;
  private _curL01 = 0;
  private _curL02 = 0;
  private _curR01 = 0;
  private _curR02 = 0;

  constructor(
    private readonly ids: {
      l01?: CubismIdHandle;
      l02?: CubismIdHandle;
      r01?: CubismIdHandle;
      r02?: CubismIdHandle;
    },
    private readonly getLeftSuppress?: () => number
  ) {}

  apply(model: CubismModel, dt = 1 / 60): void {
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const tau = this.enabled ? 0.08 : 0.12;
    const k = step > 0 ? 1 - Math.exp(-step / tau) : 1;
    const tL01 = this.enabled && Number.isFinite(this.armL01) ? this.armL01 : 0;
    const tL02 = this.enabled && Number.isFinite(this.armL02) ? this.armL02 : 0;
    const tR01 = this.enabled && Number.isFinite(this.armR01) ? this.armR01 : 0;
    const tR02 = this.enabled && Number.isFinite(this.armR02) ? this.armR02 : 0;

    this._curL01 += (tL01 - this._curL01) * k;
    this._curL02 += (tL02 - this._curL02) * k;
    this._curR01 += (tR01 - this._curR01) * k;
    this._curR02 += (tR02 - this._curR02) * k;

    if (Math.abs(this._curL01) < 0.001) this._curL01 = 0;
    if (Math.abs(this._curL02) < 0.001) this._curL02 = 0;
    if (Math.abs(this._curR01) < 0.001) this._curR01 = 0;
    if (Math.abs(this._curR02) < 0.001) this._curR02 = 0;

    const suppress = clamp(this.getLeftSuppress ? this.getLeftSuppress() : 0, 0, 1);
    const leftScale = 1 - suppress;
    if (leftScale > 0) {
      addClamped(model, this.ids.l01, this._curL01 * leftScale, -10, 10);
      addClamped(model, this.ids.l02, this._curL02 * leftScale, -10, 10);
    }
    addClamped(model, this.ids.r01, this._curR01, -10, 10);
    addClamped(model, this.ids.r02, this._curR02, -10, 10);
  }
}

/** 互动面部微表情通道（笑眼/嘴角/张嘴/眉部）；由 applyFaceVariant 在其后继续保障特殊眼型独占。 */
export class FaceMicroChannel implements OverlayChannel {
  readonly name = 'face-micro';
  enabled = false;
  eyeSmile = 0;
  mouthForm = 0;
  mouthOpen = 0;
  browY = 0;
  browAngle = 0;
  browForm = 0;

  private _eyeSmile = 0;
  private _mouthForm = 0;
  private _mouthOpen = 0;
  private _browY = 0;
  private _browAngle = 0;
  private _browForm = 0;

  constructor(
    private readonly ids: {
      eyeLSmile?: CubismIdHandle;
      eyeRSmile?: CubismIdHandle;
      mouthForm?: CubismIdHandle;
      mouthOpen?: CubismIdHandle;
      browLY?: CubismIdHandle;
      browRY?: CubismIdHandle;
      browLAngle?: CubismIdHandle;
      browRAngle?: CubismIdHandle;
      browLForm?: CubismIdHandle;
      browRForm?: CubismIdHandle;
    }
  ) {}

  apply(model: CubismModel, dt = 1 / 60): void {
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const tau = this.enabled ? 0.08 : 0.14;
    const k = step > 0 ? 1 - Math.exp(-step / tau) : 1;
    const active = this.enabled;
    const targetEye = active && Number.isFinite(this.eyeSmile) ? clamp(this.eyeSmile, 0, 1) : 0;
    const targetMf = active && Number.isFinite(this.mouthForm) ? clamp(this.mouthForm, -1, 1) : 0;
    const targetMo = active && Number.isFinite(this.mouthOpen) ? clamp(this.mouthOpen, 0, 1) : 0;
    const targetBy = active && Number.isFinite(this.browY) ? clamp(this.browY, -1, 1) : 0;
    const targetBa = active && Number.isFinite(this.browAngle) ? clamp(this.browAngle, -1, 1) : 0;
    const targetBf = active && Number.isFinite(this.browForm) ? clamp(this.browForm, -1, 1) : 0;

    this._eyeSmile += (targetEye - this._eyeSmile) * k;
    this._mouthForm += (targetMf - this._mouthForm) * k;
    this._mouthOpen += (targetMo - this._mouthOpen) * k;
    this._browY += (targetBy - this._browY) * k;
    this._browAngle += (targetBa - this._browAngle) * k;
    this._browForm += (targetBf - this._browForm) * k;

    if (this._eyeSmile < 0.001) this._eyeSmile = 0;
    if (Math.abs(this._mouthForm) < 0.001) this._mouthForm = 0;
    if (this._mouthOpen < 0.001) this._mouthOpen = 0;
    if (Math.abs(this._browY) < 0.001) this._browY = 0;
    if (Math.abs(this._browAngle) < 0.001) this._browAngle = 0;
    if (Math.abs(this._browForm) < 0.001) this._browForm = 0;

    if (this._eyeSmile > 0) {
      if (this.ids.eyeLSmile) {
        model.setParameterValueById(
          this.ids.eyeLSmile,
          Math.min(1, Math.max(model.getParameterValueById(this.ids.eyeLSmile), this._eyeSmile))
        );
      }
      if (this.ids.eyeRSmile) {
        model.setParameterValueById(
          this.ids.eyeRSmile,
          Math.min(1, Math.max(model.getParameterValueById(this.ids.eyeRSmile), this._eyeSmile))
        );
      }
    }
    addClamped(model, this.ids.mouthForm, this._mouthForm, -1, 1);
    addClamped(model, this.ids.mouthOpen, this._mouthOpen, 0, 1);
    addClamped(model, this.ids.browLY, this._browY, -1, 1);
    addClamped(model, this.ids.browRY, this._browY, -1, 1);
    addClamped(model, this.ids.browLAngle, this._browAngle, -1, 1);
    addClamped(model, this.ids.browRAngle, this._browAngle, -1, 1);
    addClamped(model, this.ids.browLForm, this._browForm, -1, 1);
    addClamped(model, this.ids.browRForm, this._browForm, -1, 1);
  }
}

export interface PartImpulseTarget {
  id: CubismIdHandle;
  weight: number;
}

export interface PartImpulseSpec {
  targets: PartImpulseTarget[];
  min: number;
  max: number;
  omega: number;
  zeta: number;
  maxAmp: number;
}

interface PartSpringState {
  spec: PartImpulseSpec;
  pos: number;
  vel: number;
}

/** 局部触碰阻尼弹簧（领带/刘海/侧发/马尾/发丝垂直弹性/双手链/猫耳），物理后叠加写入。 */
export class PartImpulseChannel implements OverlayChannel {
  readonly name = 'part-impulse';
  reducedMotion = false;
  earsVisible = true;
  private readonly _springs = new Map<PartImpulseKind, PartSpringState>();

  constructor(specs: Partial<Record<PartImpulseKind, PartImpulseSpec>>) {
    for (const [kind, spec] of Object.entries(specs) as Array<[PartImpulseKind, PartImpulseSpec]>) {
      if (spec && spec.targets.length > 0) {
        this._springs.set(kind, { spec, pos: 0, vel: 0 });
      }
    }
  }

  trigger(part: PartImpulseKind, strength: number): void {
    if (this.reducedMotion || !Number.isFinite(strength) || strength === 0) return;
    if (!this.earsVisible && (part === 'ear_left' || part === 'ear_right')) return;
    const s = this._springs.get(part);
    if (!s) return;
    const clampedStrength = clamp(strength, -1.5, 1.5);
    const maxVel = s.spec.maxAmp * s.spec.omega * 1.45;
    s.vel = clamp(s.vel + clampedStrength * s.spec.omega * s.spec.maxAmp * 1.35, -maxVel, maxVel);
  }

  clear(): void {
    for (const s of this._springs.values()) {
      s.pos = 0;
      s.vel = 0;
    }
  }

  apply(model: CubismModel, dt = 1 / 60): void {
    if (this.reducedMotion) {
      this.clear();
      return;
    }
    const total = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const n = total > 0 ? Math.max(1, Math.ceil(total / (1 / 60))) : 0;
    const step = n > 0 ? total / n : 0;

    for (const [kind, s] of this._springs) {
      if (!this.earsVisible && (kind === 'ear_left' || kind === 'ear_right')) {
        s.pos = 0;
        s.vel = 0;
        continue;
      }
      if (s.pos === 0 && s.vel === 0) continue;
      const { omega, zeta, maxAmp, min, max, targets } = s.spec;
      if (step > 0) {
        for (let i = 0; i < n; i++) {
          s.vel += (-omega * omega * s.pos - 2 * zeta * omega * s.vel) * step;
          s.pos += s.vel * step;
          if (Math.abs(s.pos) > maxAmp) {
            s.pos = Math.sign(s.pos) * maxAmp;
            if (Math.sign(s.vel) === Math.sign(s.pos)) s.vel = 0;
          }
        }
      }
      if (Math.abs(s.pos) < 0.01 && Math.abs(s.vel) < 0.05) {
        s.pos = 0;
        s.vel = 0;
        continue;
      }
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        addClamped(model, t.id, s.pos * t.weight, min, max);
      }
    }
  }
}

/** 脸红唯一覆盖层：表情、点击与撒娇取较强值，不清除其他来源的状态。 */
export class CheekChannel implements OverlayChannel {
  readonly name = 'cheek';
  enabled = false;
  value = 0;
  private _actionRemaining = 0;
  private _actionValue = 0;
  private _interactionValue = 0;
  constructor(private readonly id: CubismIdHandle) {}

  /** 与正式动作时长对齐；末尾 1.2s 为默认姿态尾垫，不再保持红晕。 */
  triggerAction(duration: number): void {
    this._actionRemaining = Math.max(0, duration - 1.2);
    // 重播不清零当前可见值，避免红晕在连续撒娇时闪灭。
  }
  releaseAction(): void {
    this._actionRemaining = 0;
  }

  apply(model: CubismModel, dt = 1 / 60): void {
    dt = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this._actionRemaining = Math.max(0, this._actionRemaining - dt);
    const t = Math.min(this._actionRemaining / 0.6, 1);
    const actionTarget = t * t * (3 - 2 * t);
    const interactionTarget = this.enabled && Number.isFinite(this.value)
      ? Math.min(1, Math.max(0, this.value)) : 0;
    const k = 1 - Math.exp(-dt / 0.1);
    const actionK = 1 - Math.exp(-dt / (actionTarget >= this._actionValue ? 0.1 : 0.18));
    this._actionValue += (actionTarget - this._actionValue) * actionK;
    this._interactionValue += (interactionTarget - this._interactionValue) * k;
    if (this._actionValue < 0.001) this._actionValue = 0;
    if (this._interactionValue < 0.0001) this._interactionValue = 0;
    if (this._actionValue === 0 && this._interactionValue === 0) return;
    // 此时已在 saveParameters 之后，base 是本帧表情值，不将覆盖写入持久基线。
    const base = model.getParameterValueById(this.id);
    model.setParameterValueById(this.id,
      Math.min(1, Math.max(base, this._interactionValue, this._actionValue)));
  }
}

/** 新版挥手/划重点选择器及两段物理输出；旧版继续使用五段右手链。 */
export interface NativeWaveIds {
  enabled: CubismIdHandle;
  forearm: CubismIdHandle;
  hand: CubismIdHandle;
  pointOut?: CubismIdHandle;
  mouthForm?: CubismIdHandle;
}

/** 挥手/划重点包络；统一在物理之后写入，结束及打断时恢复默认姿态。 */
export class HandRaiseChannel implements OverlayChannel {
  readonly name = 'hand-raise';
  private static readonly SEGMENTS = 5;
  /** 指尖递增摆幅（度）。 */
  private static readonly SWAY_AMPS = [2, 3, 4, 5.5, 7];
  private static readonly TAU_SECONDS = 0.12;
  private _raise = 0;
  private _pointOutRaise = 0;
  private _pointOutForearm = 0;
  private _pointOutHand = 0;
  private _target = 0;
  private _t = -1;
  private _contentDur = 3.0;
  private _mode: 'wave' | 'point_out' = 'wave';

  private _phase = 0;

  constructor(
    private readonly ids: CubismIdHandle[],
    private readonly nativeWave: NativeWaveIds | null = null
  ) {}

  /** 触发挥手/划重点联动；其他动作播放时调用 release 以平滑放下收场。 */
  trigger(mode: 'wave' | 'point_out' = 'wave', duration?: number): void {
    const activeRaise = mode === 'point_out' ? this._pointOutRaise : this._raise;
    if (activeRaise <= 0.001) {
      this._phase = 0;
      if (mode === 'point_out') {
        this._pointOutForearm = 0;
        this._pointOutHand = 0;
      }
    }
    this._mode = mode;
    this._contentDur = mode === 'point_out'
      ? Math.max(1.2, (duration ?? 4.35) - 1.2)
      : 3.0;
    this._t = 0;
  }
  release(): void {
    this._t = -1;
  }
  get raising(): number {
    return Math.max(this._raise, this._pointOutRaise);
  }
  get pointOutRaising(): number {
    return this._pointOutRaise;
  }

  apply(model: CubismModel, dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this._phase += dt;
    const smooth = (x: number) => {
      const c = clamp(x, 0, 1);
      return c * c * (3 - 2 * c);
    };
    let env = 0;
    if (this._t >= 0) {
      this._t += dt;
      const t = this._t;
      if (this._mode === 'wave') {
        // 包络：0.45s 举起 → 保持摆动 → 2.55s 起 0.6s 放下（对齐 wave 内容 3.0s）
        env = smooth(t / 0.45) * smooth(1 - (t - 2.55) / 0.6);
        if (t > 3.2) this._t = -1;
      } else {
        // 划重点：0.08s 随身体蓄势起手，0.44s 举稳；2.45s~2.87s 平滑放下，与头身/眼镜同步归位到 ~3.0s
        const downStart = Math.max(0.6, this._contentDur - 0.70);
        env = smooth((t - 0.08) / 0.36) * smooth(1 - (t - downStart) / 0.42);
        if (t > this._contentDur) this._t = -1;
      }
    }

    if (this.nativeWave) {
      // Param30 与 Param42 共用普通左臂隐藏与 Param31/36：互斥渐落，绝不同时 > 0 重叠双臂。
      const wantWave = this._t >= 0 && this._mode === 'wave';
      const wantPointOut = this._t >= 0 && this._mode === 'point_out' && Boolean(this.nativeWave.pointOut);
      const waveTarget = wantWave && this._pointOutRaise === 0 ? env : 0;
      const pointOutTarget = wantPointOut && this._raise === 0 ? env : 0;
      const kWave = dt > 0
        ? 1 - Math.exp(-dt / (wantPointOut ? 0.055 : HandRaiseChannel.TAU_SECONDS))
        : 0;
      // 划重点主体用紧凑跟随减少半透明拖尾，被打断释放保持平滑。
      const kPoint = dt > 0
        ? 1 - Math.exp(-dt / (wantPointOut ? 0.048 : wantWave ? 0.05 : 0.085))
        : 0;
      this._raise += (waveTarget - this._raise) * kWave;
      this._pointOutRaise += (pointOutTarget - this._pointOutRaise) * kPoint;
      if (this._raise <= (wantPointOut ? 0.02 : 0.001)) this._raise = 0;
      if (this._pointOutRaise <= (wantWave ? 0.02 : 0.001)) this._pointOutRaise = 0;
      this._target = Math.max(waveTarget, pointOutTarget);

      model.setParameterValueById(this.nativeWave.enabled, this._raise);
      if (this.nativeWave.pointOut) {
        model.setParameterValueById(this.nativeWave.pointOut, this._pointOutRaise);
      }

      // 划重点前臂/手腕平滑目标：在收手淡出前先稳回中位，避免淡出时末端乱翘；打断时阻尼回 0。
      let targetPoForearm = 0;
      let targetPoHand = 0;
      if (wantPointOut && this._raise === 0 && this._t >= 0) {
        const downStart = Math.max(0.6, this._contentDur - 0.70);
        const swayWin = smooth((this._t - 0.22) / 0.34) * smooth(1 - (this._t - (downStart - 0.30)) / 0.38);
        const beat = Math.sin(Math.max(0, this._t - 0.28) * 4.6);
        targetPoForearm = (-0.06 + 0.28 * beat) * swayWin;
        targetPoHand = (0.12 + 0.34 * beat) * swayWin;
      }
      const kSway = dt > 0 ? 1 - Math.exp(-dt / 0.065) : 0;
      this._pointOutForearm += (targetPoForearm - this._pointOutForearm) * kSway;
      this._pointOutHand += (targetPoHand - this._pointOutHand) * kSway;
      if (this._pointOutRaise === 0) {
        this._pointOutForearm = 0;
        this._pointOutHand = 0;
      } else {
        if (Math.abs(this._pointOutForearm) < 0.001) this._pointOutForearm = 0;
        if (Math.abs(this._pointOutHand) < 0.001) this._pointOutHand = 0;
      }

      if (this._raise > 0) {
        model.setParameterValueById(
          this.nativeWave.forearm,
          Math.sin(this._phase * 10) * 0.65 * this._raise
        );
        model.setParameterValueById(
          this.nativeWave.hand,
          Math.sin(this._phase * 10 - 0.6) * 0.8 * this._raise
        );
      } else if (this._pointOutRaise > 0) {
        model.setParameterValueById(this.nativeWave.forearm, this._pointOutForearm);
        model.setParameterValueById(this.nativeWave.hand, this._pointOutHand);
      } else {
        model.setParameterValueById(this.nativeWave.forearm, 0);
        model.setParameterValueById(this.nativeWave.hand, 0);
      }
      if (this.nativeWave.mouthForm && this._pointOutRaise > 0) {
        const baseMf = model.getParameterValueById(this.nativeWave.mouthForm);
        const w = clamp(this._pointOutRaise, 0, 1);
        model.setParameterValueById(
          this.nativeWave.mouthForm,
          clamp(baseMf + (1 - baseMf) * w, -1, 1)
        );
      }
      return;
    }

    this._target = this._t >= 0 && this._mode === 'wave' ? env : 0;
    const k = dt > 0 ? 1 - Math.exp(-dt / HandRaiseChannel.TAU_SECONDS) : 0;
    this._raise += (this._target - this._raise) * k;
    if (this._raise <= 0.001) this._raise = 0;
    if (this._raise === 0) return;

    const swayT = Math.max(this._t, 0);
    for (let s = 0; s < Math.min(this.ids.length, HandRaiseChannel.SEGMENTS); s++) {
      const lift = -45 * this._raise; // 右手链负角为抬
      const sway =
        Math.sin(swayT * 13.8 - s * 0.6) *
        HandRaiseChannel.SWAY_AMPS[s] *
        this._raise;
      model.addParameterValueById(this.ids[s], lift + sway);
    }
  }
}

/** 黑框眼镜（Param43）：常驻饰品开关与「划重点」动作临时佩戴共同驱动，S 曲线平滑渐入渐出。 */
export class GlassesChannel implements OverlayChannel {
  readonly name = 'glasses';
  private static readonly FADE_IN_SECONDS = 0.28;
  private static readonly FADE_OUT_SECONDS = 0.38;
  private _visible = false;
  private _actionRemaining = 0;
  private _blend = 0;
  private _value = 0;

  constructor(private readonly id?: CubismIdHandle) {}

  get visible(): boolean {
    return this._visible;
  }

  setVisible(visible: boolean, immediate = false): void {
    this._visible = visible;
    if (immediate) {
      this._blend = this._visible || this._actionRemaining > 0 ? 1 : 0;
      this._value = this._blend;
    }
  }

  /** 对齐动作主体收尾：在 ~2.60s 起开始 0.38s 平滑摘下，于 ~2.98s 与手臂/头身同步收完。 */
  triggerAction(duration: number): void {
    this._actionRemaining = Math.max(0, duration - 1.75);
  }

  releaseAction(): void {
    this._actionRemaining = 0;
  }

  get value(): number {
    return this._value;
  }

  apply(model: CubismModel, dt = 1 / 60): void {
    if (!this.id) return;
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    this._actionRemaining = Math.max(0, this._actionRemaining - step);
    const target = this._visible || this._actionRemaining > 0 ? 1 : 0;
    if (this._blend !== target && step > 0) {
      const fade = target > this._blend ? GlassesChannel.FADE_IN_SECONDS : GlassesChannel.FADE_OUT_SECONDS;
      const delta = step / fade;
      this._blend = target > this._blend
        ? Math.min(target, this._blend + delta)
        : Math.max(target, this._blend - delta);
    }
    this._value = this._blend * this._blend * (3 - 2 * this._blend);
    model.setParameterValueById(this.id, this._value);
  }
}

/**
 * 生气阴影拆分：模型把黑脸（整脸阴影）和怒气符号挂在同一个 Param32 上，
 * 参数层无法单独显示其一。这里在 model.update() 之后按网格乘不透明度，
 * Param32 仍决定出现与淡入淡出；遮罩本身也平滑过渡，切表情不闪。
 * 只在 Param32 > 0 时生效，其余表情与动作不受影响。
 */
export class AngerMarkSplit {
  /** 目标遮罩：1 = 显示，0 = 隐藏。 */
  private _targetShade = 1;
  private _targetMark = 1;
  private _shade = 1;
  private _mark = 1;
  private static readonly TAU_SECONDS = 0.12;

  constructor(
    private readonly shadeIndex: number,
    private readonly markIndex: number
  ) {}

  private _releasePending = false;

  /**
   * 'both' 为模型原样；'mark' 只留怒气符号；'shade' 只留黑脸。
   * null：切到不用 Param32 的表情。旧表情的阴影仍在淡出，若立刻恢复 both
   * 会让被隐藏的那一半在淡出途中闪现，所以等 Param32 归零后再恢复。
   */
  setMode(mode: 'both' | 'mark' | 'shade' | null): void {
    this._releasePending = mode === null;
    if (mode === null) return;
    this._targetShade = mode === 'mark' ? 0 : 1;
    this._targetMark = mode === 'shade' ? 0 : 1;
  }

  /**
   * 须在 model.update() 之后、绘制之前调用（直接改 Core 已求值的不透明度）。
   * @param driver 本帧最终的 Param32 值
   */
  apply(opacities: Float32Array, dt: number, driver: number): void {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (this._releasePending && !(driver > 0)) {
      this._releasePending = false;
      this._targetShade = this._targetMark = this._shade = this._mark = 1;
    }
    const k = 1 - Math.exp(-dt / AngerMarkSplit.TAU_SECONDS);
    this._shade += (this._targetShade - this._shade) * k;
    this._mark += (this._targetMark - this._mark) * k;
    if (Math.abs(this._shade - this._targetShade) < 0.001) this._shade = this._targetShade;
    if (Math.abs(this._mark - this._targetMark) < 0.001) this._mark = this._targetMark;
    if (this._shade !== 1) opacities[this.shadeIndex] *= this._shade;
    if (this._mark !== 1) opacities[this.markIndex] *= this._mark;
  }
}

/** 固定顺序通道集合。 */
export class OverlayLayer {
  private readonly _channels: OverlayChannel[] = [];
  add(channel: OverlayChannel): void {
    this._channels.push(channel);
  }
  apply(model: CubismModel, dt: number): void {
    for (let i = 0; i < this._channels.length; i++) {
      this._channels[i].apply(model, dt);
    }
  }
}
