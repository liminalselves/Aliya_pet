/**
 * 程序化互动反应与指针追踪小服务（移植自 Flutter 同名服务）：
 *   - ClickSequenceService：3秒3次疑惑 / 4秒5次吐槽 / 6秒8次点击冷却
 *   - DragReactionService：快速拖动（≥250px/s）检测
 *   - PointerProximityService：指针位置/速度平滑滤波
 *   - ProceduralReactionService：程序微动（catalog.ts kind=procedural 的动作）的相位动画，
 *     经互动覆盖通道写头部偏移、眼睑、猫耳、脸红
 */

import { InteractionTarget, type InteractionPose } from './target';

// ---------- 连续点击检测 ----------

export enum ClickResult {
  none,
  /** 3 秒内 3 次：疑惑反应 */
  doubt,
  /** 4 秒内 5 次：轻微吐槽 */
  comment,
  /** 6 秒内 8 次：进入点击冷却 */
  cooldown,
}

export class ClickSequenceService {
  private _clicks: number[] = [];
  private _areaClicks = new Map<string, number[]>();
  private _cooldownUntilMs = 0;

  get isInCooldown(): boolean {
    return performance.now() < this._cooldownUntilMs;
  }

  registerClick(area?: string): ClickResult {
    const now = performance.now();
    if (this.isInCooldown) return ClickResult.cooldown;
    if (this._cooldownUntilMs > 0) this.reset();
    this._clicks.push(now);
    while (this._clicks.length > 0 && now - this._clicks[0] > 6000) {
      this._clicks.shift();
    }

    if (this.isInCooldown) return ClickResult.cooldown;

    if (this._countWithin(this._clicks, now, 6) >= 8) {
      this._cooldownUntilMs = now + 3000;
      return ClickResult.cooldown;
    }

    if (area) {
      let list = this._areaClicks.get(area);
      if (!list) {
        list = [];
        this._areaClicks.set(area, list);
      }
      list.push(now);
      for (const [k, times] of this._areaClicks) {
        while (times.length > 0 && now - times[0] > 6000) times.shift();
        if (times.length === 0) this._areaClicks.delete(k);
      }
      if (this._countWithin(list, now, 4) >= 5 || this._countWithin(this._clicks, now, 4) >= 6) {
        return ClickResult.comment;
      }
      if (this._countWithin(list, now, 3) >= 3) return ClickResult.doubt;
      return ClickResult.none;
    }

    if (this._countWithin(this._clicks, now, 4) >= 5) return ClickResult.comment;
    if (this._countWithin(this._clicks, now, 3) >= 3) return ClickResult.doubt;
    return ClickResult.none;
  }

  reset(): void {
    this._clicks.length = 0;
    this._areaClicks.clear();
    this._cooldownUntilMs = 0;
  }

  private _countWithin(list: number[], now: number, seconds: number): number {
    let count = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (now - list[i] <= seconds * 1000) count++;
      else break;
    }
    return count;
  }
}

// ---------- 快速拖动与摇晃检测 ----------

export class DragReactionService {
  private static readonly _fastDragSpeedThreshold = 160; // CSS px/秒（兼容高 DPI 下实际鼠标/触控位移尺度）
  private static readonly _shakeMinSpeed = 100;
  private static readonly _shakeMinTravelPx = 12;
  private static readonly _shakeWindowMs = 900;
  private static readonly _shakeCooldownMs = 2500;

  private _dragging = false;
  private _maxSpeedPxPerSec = 0;
  private _shakeDir = 0;
  private _shakeTravel = 0;
  private _shakeOppositeTravel = 0;
  private _shakeReversals: number[] = [];
  private _lastShakeAtMs = -Infinity;
  private _shakeDetected = false;

  get isDragging(): boolean {
    return this._dragging;
  }

  get hadShake(): boolean {
    return this._shakeDetected;
  }

  beginDrag(): void {
    this._dragging = true;
    this._maxSpeedPxPerSec = 0;
    this._shakeDir = 0;
    this._shakeTravel = 0;
    this._shakeOppositeTravel = 0;
    this._shakeReversals.length = 0;
    this._shakeDetected = false;
  }

  cancel(): void {
    this._dragging = false;
    this._maxSpeedPxPerSec = 0;
    this._shakeDir = 0;
    this._shakeTravel = 0;
    this._shakeOppositeTravel = 0;
    this._shakeReversals.length = 0;
    this._shakeDetected = false;
  }

  onDragMove(speedPxPerSec: number): void {
    if (!this._dragging) return;
    if (Number.isFinite(speedPxPerSec)) {
      this._maxSpeedPxPerSec = Math.max(
        this._maxSpeedPxPerSec,
        Math.abs(speedPxPerSec)
      );
    }
  }

  /** 带方向信息的拖动步进（CSS px/s），检测高速与连续快速摇晃。 */
  onDragMotion(vxCssPerSec: number, vyCssPerSec: number, dtSeconds: number): { shakeTriggered: boolean } {
    if (!this._dragging) return { shakeTriggered: false };
    if (Number.isFinite(vxCssPerSec) && Number.isFinite(vyCssPerSec)) {
      this.onDragMove(Math.hypot(vxCssPerSec, vyCssPerSec));
    }
    if (!Number.isFinite(vxCssPerSec) || !Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return { shakeTriggered: false };
    }
    const speed = Math.abs(vxCssPerSec);
    if (speed < DragReactionService._shakeMinSpeed) return { shakeTriggered: false };
    const dir = Math.sign(vxCssPerSec);
    const step = Math.abs(vxCssPerSec * Math.min(dtSeconds, 0.1));
    if (this._shakeDir === 0) {
      this._shakeDir = dir;
      this._shakeTravel = step;
      this._shakeOppositeTravel = 0;
      return { shakeTriggered: false };
    }
    if (dir === this._shakeDir) {
      this._shakeTravel += step;
      this._shakeOppositeTravel = 0;
      return { shakeTriggered: false };
    }
    // 反向累积位移达到阈值才计入一次有效摇晃反转，过滤微小抖动
    this._shakeOppositeTravel += step;
    if (this._shakeTravel < DragReactionService._shakeMinTravelPx) {
      this._shakeDir = dir;
      this._shakeTravel = this._shakeOppositeTravel;
      this._shakeOppositeTravel = 0;
      return { shakeTriggered: false };
    }
    if (this._shakeOppositeTravel < DragReactionService._shakeMinTravelPx) {
      return { shakeTriggered: false };
    }
    this._shakeDir = dir;
    this._shakeTravel = this._shakeOppositeTravel;
    this._shakeOppositeTravel = 0;
    const now = performance.now();
    this._shakeReversals.push(now);
    while (
      this._shakeReversals.length > 0 &&
      now - this._shakeReversals[0] > DragReactionService._shakeWindowMs
    ) {
      this._shakeReversals.shift();
    }
    if (
      this._shakeReversals.length >= 3 &&
      now - this._lastShakeAtMs >= DragReactionService._shakeCooldownMs
    ) {
      this._lastShakeAtMs = now;
      this._shakeReversals.length = 0;
      this._shakeDetected = true;
      return { shakeTriggered: true };
    }
    return { shakeTriggered: false };
  }

  /** 结束拖动。返回本轮是否达到快速拖动阈值。 */
  endDrag(): boolean {
    if (!this._dragging) return false;
    this._dragging = false;
    return this._maxSpeedPxPerSec >= DragReactionService._fastDragSpeedThreshold;
  }
}

// ---------- 指针邻近与速度追踪 ----------

export class PointerProximityService {
  private _has = false;
  private _lastTimeMs = 0;
  private _lastPxX = 0;
  private _lastPxY = 0;
  private _smoothVelX = 0;
  private _smoothVelY = 0;
  private _smoothNormX = 0;
  private _smoothNormY = 0;

  update(ctx: { normX: number; normY: number; pxX: number; pxY: number }): void {
    const now = performance.now();
    if (this._has) {
      const dt = Math.max(0.001, (now - this._lastTimeMs) / 1000);
      const velX = (ctx.pxX - this._lastPxX) / dt;
      const velY = (ctx.pxY - this._lastPxY) / dt;
      this._smoothVelX = this._smoothVelX * 0.6 + velX * 0.4;
      this._smoothVelY = this._smoothVelY * 0.6 + velY * 0.4;
    } else {
      this._smoothVelX = 0;
      this._smoothVelY = 0;
    }
    this._lastTimeMs = now;
    this._lastPxX = ctx.pxX;
    this._lastPxY = ctx.pxY;
    this._smoothNormX = ctx.normX;
    this._smoothNormY = ctx.normY;
    this._has = true;
  }

  reset(): void {
    this._has = false;
    this._smoothVelX = 0;
    this._smoothVelY = 0;
  }

  get smoothedVelXPxPerSec(): number {
    return this._smoothVelX;
  }
  get smoothedVelYPxPerSec(): number {
    return this._smoothVelY;
  }
  get smoothedNormX(): number {
    return this._smoothNormX;
  }
  get smoothedNormY(): number {
    return this._smoothNormY;
  }
}

// ---------- 程序化反应 ----------

/** 程序微动名 = catalog.ts 中 kind=procedural 的动作名。 */
export type ProceduralReactionType =
  | 'acknowledge'
  | 'tilt'
  | 'nuzzle'
  | 'flinch'
  | 'blush'
  | 'ear_blink'
  | 'eyes_widen'
  | 'tie_tug'
  | 'leg_pout'
  | 'look_back'
  | 'landing';

export interface ProceduralReaction {
  type: ProceduralReactionType;
  strength: number;
  /** 触发的命中区域；ear_left/ear_right 决定单眼眨的一侧。 */
  areaId?: string;
  /** 模型空间水平朝向：+1 = 画面右（未镜像时），用于蹭手、回头等朝向反应。 */
  side?: number;
}

/** 各微动的默认强度（反应组未指定 strength 时使用）。 */
export const PROCEDURAL_DEFAULT_STRENGTH: Record<ProceduralReactionType, number> = {
  acknowledge: 0.8, tilt: 0.8, nuzzle: 0.8, flinch: 0.9, blush: 1, ear_blink: 0.8,
  eyes_widen: 1, tie_tug: 1, leg_pout: 1, look_back: 1, landing: 1,
};

export function isProceduralReactionType(name: string): name is ProceduralReactionType {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_DEFAULT_STRENGTH, name);
}

export function proceduralReaction(
  type: ProceduralReactionType,
  opts: { strength?: number; areaId?: string; side?: number } = {},
): ProceduralReaction {
  return { type, strength: opts.strength ?? PROCEDURAL_DEFAULT_STRENGTH[type], areaId: opts.areaId, side: opts.side };
}

interface Phase {
  durationMs: number;
  eyeOpen: number;
  headX: number;
  headY: number;
  headZ: number;
  earL: number;
  earR: number;
  cheek: number;
  bodyX: number;
  releaseEye?: boolean;
}

const NEUTRAL: Phase = {
  durationMs: 0,
  eyeOpen: 1,
  headX: 0,
  headY: 0,
  headZ: 0,
  earL: 0,
  earR: 0,
  cheek: 0,
  bodyX: 0,
};

function phase(
  durationMs: number,
  eyeOpen: number,
  headX: number,
  headY: number,
  headZ: number,
  earL: number,
  earR: number,
  cheek = 0,
  bodyX = 0,
  releaseEye = false
): Phase {
  return { durationMs, eyeOpen, headX, headY, headZ, earL, earR, cheek, bodyX, releaseEye };
}

/**
 * 相位动画反应服务。每帧由渲染循环驱动 tick()。
 * 抚摸模式期间不叠加程序化反应（apply 直接忽略）。
 */
export class ProceduralReactionService {
  private readonly _getTarget: () => InteractionTarget | null;
  private readonly _isPettingActive: () => boolean;
  private readonly _takeOverPetting?: () => InteractionPose | null;
  private _recovery: { from: InteractionPose; current: InteractionPose; startMs: number } | null = null;

  private _phases: Phase[] = [];
  private _phaseIndex = 0;
  private _phaseStartMs = 0;
  private _prev: Phase = NEUTRAL;

  private _eyeOpen = 1;
  private _headX = 0;
  private _headY = 0;
  private _headZ = 0;
  private _bodyX = 0;
  private _earL = 0;
  private _earR = 0;
  private _cheek = 0;
  private _eyeOverrideActive = false;
  private _eyeSide: 'both' | 'left' | 'right' = 'both';
  /** 拖动「拎起」姿态：相位播完后保持末相位，直到下一次 apply/cancel。 */
  private _holding = false;
  private _holdSway = 0;
  private _holdSwayTarget = 0;
  private _lastTickMs = 0;

  constructor(deps: {
    getTarget: () => InteractionTarget | null;
    isPettingActive: () => boolean;
    takeOverPetting?: () => InteractionPose | null;
  }) {
    this._getTarget = deps.getTarget;
    this._isPettingActive = deps.isPettingActive;
    this._takeOverPetting = deps.takeOverPetting;
  }

  get isPlaying(): boolean {
    return this._phases.length > 0 || this._recovery !== null || this._holding;
  }

  get isHolding(): boolean {
    return this._holding;
  }

  apply(reaction: ProceduralReaction): void {
    if (this._getTarget() == null) return;
    // Finishing 可被点击接管；Pressed/Petting 仍独占互动通道。
    const pose = this._takeOverPetting?.();
    if (this._isPettingActive()) return;
    if (pose) {
      this._recovery = { from: pose, current: pose, startMs: performance.now() };
    }

    // area 是未镜像画面侧，参数 L/R 是角色解剖侧（实模顶点验证为左右相反）。
    // 镜像已由 HitAreas 还原，这里只映射一次；脸红和单纯转头不抢占眼睑。
    this._eyeSide = reaction.areaId === 'ear_left' ? 'right'
      : reaction.areaId === 'ear_right' ? 'left' : 'both';
    switch (reaction.type) {
      case 'acknowledge': {
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(140, 1, 1.5 * s, -3 * s, 2 * s, 0, 0, 0, 0.8 * s),
          phase(140, 1, 1.5 * s, -3 * s, 2 * s, 0, 0, 0, 0.8 * s),
          phase(280, 1, 0, 0, 0, 0, 0, 0, 0),
        ]);
        break;
      }
      case 'tilt':
        this._start([
          phase(180, 0.85, 2.5, 0, -3, 0, 0, 0, -1.0),
          phase(320, 0.85, 2.5, 0, -3, 0, 0, 0, -1.0),
          phase(320, 1.0, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      case 'ear_blink': {
        const left = reaction.areaId === 'ear_left';
        this._start([
          phase(120, 0, 0, 0, left ? -1.5 : 1.5, 0, 0),
          phase(60, 0, 0, 0, left ? -1.5 : 1.5, 0, 0),
          phase(240, 1, 0, 0, 0, 0, 0),
        ]);
        break;
      }
      case 'eyes_widen':
        this._start([
          phase(180, 1.3, 0, 0, 0, 0, 0),
          phase(260, 1.3, 0, 0, 0, 0, 0),
          phase(300, 1.0, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      case 'blush':
        this._start([
          phase(300, 1.0, 0, 0, 0, 0, 0, 0.85 * Math.min(1, Math.max(0, reaction.strength))),
          phase(900, 1.0, 0, 0, 0, 0, 0, 0.85 * Math.min(1, Math.max(0, reaction.strength))),
          phase(700, 1.0, 0, 0, 0, 0, 0, 0.0),
        ]);
        break;
      case 'nuzzle': {
        // 闭眼把头蹭向触点一侧，带一点红晕。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const side = (reaction.side ?? 1) >= 0 ? 1 : -1;
        const z = side * 5 * s;
        this._start([
          phase(240, 0, z * 0.3, -1.5 * s, z, 0, 0, 0.4 * s, 1.5 * s * side),
          phase(520, 0, z * 0.3, -1.5 * s, z * 1.15, 0, 0, 0.45 * s, 1.5 * s * side),
          phase(380, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'flinch': {
        // 被戳脸：缩一下眯眼，再红着脸回来。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(90, 0.35, 0, 3 * s, -1.5 * s, 0, 0, 0.5 * s, -1.4 * s),
          phase(220, 0.4, 0, 2.5 * s, -1.5 * s, 0, 0, 0.6 * s, -1.2 * s),
          phase(450, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'tie_tug': {
        // 领带被拽：头被带着往下点，再抬回来。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(150, 1, 0, -5 * s, 2 * s, 0, 0, 0, 0.8 * s),
          phase(260, 1, 0, -5 * s, 2 * s, 0, 0, 0, 0.8 * s),
          phase(200, 1, 0, -1 * s, 0.5 * s, 0, 0),
          phase(300, 1, 0, 0, 0, 0, 0),
        ]);
        break;
      }
      case 'leg_pout': {
        // 碰到腿：扭头半眯眼，脸微红。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(200, 0.75, -4 * s, 1.5 * s, -2 * s, 0, 0, 0.35 * s, -1.5 * s),
          phase(600, 0.75, -4 * s, 1.5 * s, -2 * s, 0, 0, 0.35 * s, -1.5 * s),
          phase(400, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'look_back': {
        // 朝触点一侧回头看（缺省画面左侧，AngleX 负），眨一下再转回。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const d = (reaction.side ?? -1) >= 0 ? -1 : 1;
        this._start([
          phase(260, 1, -8 * s * d, 1.5 * s, 2.5 * s * d, 0, 0, 0, -2.2 * s * d),
          phase(420, 1, -8 * s * d, 1.5 * s, 2.5 * s * d, 0, 0, 0, -2.2 * s * d),
          phase(90, 0, -7 * s * d, 1 * s, 2 * s * d, 0, 0, 0, -1.8 * s * d),
          phase(110, 1, -6 * s * d, 1 * s, 2 * s * d, 0, 0, 0, -1.4 * s * d, true),
          phase(380, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'landing': {
        // 慢慢放下：落地轻轻一顿。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(120, 0.75, 0, -3 * s, 0, 0, 0),
          phase(280, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
    }
    this._holding = false;
    this._eyeOverrideActive = reaction.type !== 'blush' && reaction.type !== 'acknowledge'
      && reaction.type !== 'tie_tug';
  }

  /** 拖动期间保持「被拎起」姿态：睁大眼、微抬头；松手由下一个反应平滑接管。 */
  hold(): void {
    if (this._getTarget() == null || this._isPettingActive()) return;
    this._start([phase(220, 1.15, 0, 3, 0, 0, 0)]);
    this._holding = true;
    this._holdSway = 0;
    this._holdSwayTarget = 0;
    this._lastTickMs = performance.now();
  }

  /** 拖动时头部按惯性反向轻摆；vx 为模型空间水平速度（px/s，+ = 模型右）。 */
  setHoldSway(vxPxPerSec: number): void {
    if (!this._holding || !Number.isFinite(vxPxPerSec)) return;
    this._holdSwayTarget = Math.max(-6, Math.min(6, -vxPxPerSec / 600 * 5));
  }

  cancelAll(immediate = false): void {
    if (!immediate && this.isPlaying) {
      this._start([phase(180, 1, 0, 0, 0, 0, 0, 0, 0, true)]);
      this._holding = false;
      this._eyeOverrideActive = false;
      return;
    }
    this._holding = false;
    this._holdSway = this._holdSwayTarget = 0;
    this._phases.length = 0;
    this._recovery = null;
    this._phaseIndex = 0;
    this._eyeOverrideActive = false;
    this._eyeOpen = 1;
    this._headX = this._headY = this._headZ = this._bodyX = this._earL = this._earR = 0;
    this._cheek = 0;
    const target = this._getTarget();
    if (target) {
      try {
        target.setInteractionOffsets(0, 0, 0, 0);
        target.setEyeOverride(false, 0, 0);
        target.setEarInteraction(false, 0, 0);
        target.setFaceCheek(false, 0);
      } catch {
        // 忽略
      }
    }
  }

  private _start(phases: Phase[]): void {
    // 恢复期内再次点击，从上一帧实际输出重新交接，不能回退到旧抚摸姿态。
    if (this._recovery) {
      this._recovery.from = this._recovery.current;
      this._recovery.startMs = performance.now();
    }
    // 拎起摆动并入可见姿态后再交接，松手反应从当前头角继续而非跳回。
    this._headZ += this._holdSway;
    this._holdSway = this._holdSwayTarget = 0;
    this._phases = phases.length > 0 ? [...phases] : [NEUTRAL];
    this._phaseIndex = 0;
    this._phaseStartMs = performance.now();
    this._prev = { durationMs: 0, eyeOpen: this._eyeOpen, headX: this._headX,
      headY: this._headY, headZ: this._headZ, earL: this._earL, earR: this._earR,
      cheek: this._cheek, bodyX: this._bodyX };
    this._eyeOverrideActive = true;
  }

  /** 每帧驱动（由渲染循环调用）。 */
  tick(): void {
    const target = this._getTarget();
    if (!target) return;
    if (!this.isPlaying) return;

    const now = performance.now();
    const t = (now - this._phaseStartMs) / 1000;
    if (this._holding) {
      // 惯性摆动：时间常数 0.12s 逼近目标，目标自身也缓慢回中（停手后头回正）。
      const dt = Math.max(0, Math.min(0.1, (now - this._lastTickMs) / 1000));
      this._lastTickMs = now;
      this._holdSway += (this._holdSwayTarget - this._holdSway) * (1 - Math.exp(-dt / 0.12));
      this._holdSwayTarget *= Math.exp(-dt / 0.25);
    }
    if (this._holding && this._phaseIndex >= this._phases.length) {
      // 保持末相位，不回中性。
    } else if (this._phaseIndex >= this._phases.length) {
      // 已结束：回到中性
      this._eyeOpen = 1;
      this._headX = this._headY = this._headZ = this._bodyX = this._earL = this._earR = 0;
      this._cheek = 0;
      this._eyeOverrideActive = false;
      this._phases.length = 0;
    } else {
      const p = this._phases[this._phaseIndex];
      if (p.releaseEye) this._eyeOverrideActive = false;
      const progress = Math.min(
        Math.max(t / Math.max(p.durationMs / 1000, 0.001), 0),
        1
      );
      const k = progress * progress * (3 - 2 * progress);
      this._eyeOpen = this._prev.eyeOpen + (p.eyeOpen - this._prev.eyeOpen) * k;
      this._headX = this._prev.headX + (p.headX - this._prev.headX) * k;
      this._headY = this._prev.headY + (p.headY - this._prev.headY) * k;
      this._headZ = this._prev.headZ + (p.headZ - this._prev.headZ) * k;
      this._bodyX = this._prev.bodyX + (p.bodyX - this._prev.bodyX) * k;
      this._earL = this._prev.earL + (p.earL - this._prev.earL) * k;
      this._earR = this._prev.earR + (p.earR - this._prev.earR) * k;
      this._cheek = this._prev.cheek + (p.cheek - this._prev.cheek) * k;

      if (k >= 1.0) {
        this._prev = p;
        this._phaseIndex++;
        this._phaseStartMs = now;
      }
    }

    // 只由本服务写通道：从抚摸的最后一帧平滑混入新反应，而非先清零。
    let output: InteractionPose = {
      headX: this._headX, headY: this._headY, headZ: this._headZ + this._holdSway, bodyX: this._bodyX,
      eyeEnabled: this._eyeOverrideActive,
      eyeLeft: this._eyeOpen, eyeRight: this._eyeOpen,
      earL: this._earL, earR: this._earR, cheek: this._cheek,
    };
    let side = this._eyeSide;
    if (this._recovery) {
      const { from, startMs } = this._recovery;
      const rt = Math.min(Math.max((now - startMs) / 240, 0), 1);
      const rk = rt * rt * (3 - 2 * rt);
      const blend = (a: number, b: number) => a + (b - a) * rk;
      output = {
        headX: blend(from.headX, output.headX), headY: blend(from.headY, output.headY),
        headZ: blend(from.headZ, output.headZ), bodyX: blend(from.bodyX, output.bodyX),
        eyeEnabled: output.eyeEnabled || (from.eyeEnabled && rt < 1),
        eyeLeft: blend(from.eyeEnabled ? from.eyeLeft : 1,
          output.eyeEnabled && side !== 'right' ? this._eyeOpen : 1),
        eyeRight: blend(from.eyeEnabled ? from.eyeRight : 1,
          output.eyeEnabled && side !== 'left' ? this._eyeOpen : 1),
        earL: blend(from.earL ?? 0, output.earL ?? 0),
        earR: blend(from.earR ?? 0, output.earR ?? 0),
        cheek: blend(from.cheek ?? 0, output.cheek ?? 0),
      };
      // 另一只眼只平滑睁开，不跟随耳朵点击再次闭眼。
      if (from.eyeEnabled && rt < 1) side = 'both';
      this._recovery.current = output;
      if (rt >= 1) this._recovery = null;
    }
    try {
      target.setInteractionOffsets(output.headX, output.headY, output.headZ, output.bodyX);
      if (output.eyeEnabled) {
        target.setEyeOverride(true, output.eyeLeft, output.eyeRight, side);
      } else {
        target.setEyeOverride(false, 0, 0);
      }
      target.setEarInteraction(
        this._earL !== 0 || this._earR !== 0,
        this._earL,
        this._earR
      );
      const cheek = output.cheek ?? this._cheek;
      target.setFaceCheek(cheek !== 0, cheek);
    } catch {
      // 写入失败忽略
    }
  }
}
