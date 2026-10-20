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

export interface OverlayChannel {
  readonly name: string;
  apply(model: CubismModel, dt: number): void;
}

/** 互动层（抚摸状态机）的头部/身体偏移——绝对值写入由上层每帧重设。 */
export class InteractionOffsetChannel implements OverlayChannel {
  readonly name = 'interaction-offset';
  angleX = 0;
  angleY = 0;
  angleZ = 0;
  bodyX = 0;
  constructor(
    private readonly ids: {
      angleX: CubismIdHandle;
      angleY: CubismIdHandle;
      angleZ: CubismIdHandle;
      bodyAngleX: CubismIdHandle;
    }
  ) {}
  private readonly _values = [0, 0, 0, 0];
  apply(model: CubismModel, dt = 1 / 60): void {
    const k = 1 - Math.exp(-Math.max(0, Number.isFinite(dt) ? dt : 0) / 0.06);
    // 从点击交给抚摸、失焦回中时也从当前偏移继续，不清零跳帧。
    this._values[0] += (this.angleX - this._values[0]) * k;
    this._values[1] += (this.angleY - this._values[1]) * k;
    this._values[2] += (this.angleZ - this._values[2]) * k;
    this._values[3] += (this.bodyX - this._values[3]) * k;
    for (let i = 0; i < 4; i++) if (Math.abs(this._values[i]) < 0.0001) this._values[i] = 0;
    if (this._values[0] !== 0) model.addParameterValueById(this.ids.angleX, this._values[0]);
    if (this._values[1] !== 0) model.addParameterValueById(this.ids.angleY, this._values[1]);
    if (this._values[2] !== 0) model.addParameterValueById(this.ids.angleZ, this._values[2]);
    if (this._values[3] !== 0) model.addParameterValueById(this.ids.bodyAngleX, this._values[3]);
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

/** 猫耳抽动：原生 ParamEarL/R（0..1）或物理输出 Param9/13（×12 缩放）。 */
export class EarChannel implements OverlayChannel {
  readonly name = 'ear';
  enabled = false;
  left = 0;
  right = 0;
  scale = 1;
  constructor(
    private readonly ids: { left: CubismIdHandle; right: CubismIdHandle }
  ) {}
  apply(model: CubismModel): void {
    if (!this.enabled) return;
    model.addParameterValueById(this.ids.left, this.left * this.scale);
    model.addParameterValueById(this.ids.right, this.right * this.scale);
  }
}

/** 脸红（互动优先于表情的 Cheek 写入）。 */
export class CheekChannel implements OverlayChannel {
  readonly name = 'cheek';
  enabled = false;
  value = 0;
  constructor(private readonly id: CubismIdHandle) {}
  apply(model: CubismModel): void {
    if (!this.enabled) return;
    model.setParameterValueById(this.id, this.value);
  }
}

/** 新版挥手选择器及两段物理输出；旧版继续使用五段右手链。 */
export interface NativeWaveIds {
  enabled: CubismIdHandle;
  forearm: CubismIdHandle;
  hand: CubismIdHandle;
}

/** 挥手包络；统一在物理之后写入，结束及打断时恢复默认姿态。 */
export class HandRaiseChannel implements OverlayChannel {
  readonly name = 'hand-raise';
  private static readonly SEGMENTS = 5;
  /** 指尖递增摆幅（度）。 */
  private static readonly SWAY_AMPS = [2, 3, 4, 5.5, 7];
  private static readonly TAU_SECONDS = 0.12;
  private _raise = 0;
  private _target = 0;
  private _t = -1;

  private _phase = 0;

  constructor(
    private readonly ids: CubismIdHandle[],
    private readonly nativeWave: NativeWaveIds | null = null
  ) {}

  /** 触发挥手联动；非 wave 动作播放时调用则以平滑放下收场。 */
  trigger(): void {
    if (this._raise <= 0.001) this._phase = 0;
    this._t = 0;
  }
  release(): void {
    this._t = -1;
  }
  get raising(): number {
    return this._raise;
  }

  apply(model: CubismModel, dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this._phase += dt;
    // 包络：0.45s 举起 → 保持摆动 → 2.55s 起 0.6s 放下（对齐 wave 内容 3.0s）
    if (this._t >= 0) {
      this._t += dt;
      const t = this._t;
      const up = Math.min(t / 0.45, 1);
      const down = t < 2.55 ? 1 : Math.max(0, 1 - (t - 2.55) / 0.6);
      this._target =
        up * up * (3 - 2 * up) * (down * down * (3 - 2 * down));
      if (t > 3.2) this._t = -1;
    } else {
      this._target = 0;
    }
    this._raise +=
      (this._target - this._raise) *
      (1 - Math.exp(-dt / HandRaiseChannel.TAU_SECONDS));
    if (this._raise <= 0.001) this._raise = 0;

    if (this.nativeWave) {
      // Param30 驱动模型内普通手臂与挥手图层的交叉渐变，保留连续包络。
      // 两段摆动随包络回落；每帧显式复位，防止物理或旧动作残留。
      const active = this._raise > 0;
      model.setParameterValueById(this.nativeWave.enabled, this._raise);
      model.setParameterValueById(
        this.nativeWave.forearm,
        active ? Math.sin(this._phase * 10) * 0.65 * this._raise : 0
      );
      model.setParameterValueById(
        this.nativeWave.hand,
        active ? Math.sin(this._phase * 10 - 0.6) * 0.8 * this._raise : 0
      );
      return;
    }
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
