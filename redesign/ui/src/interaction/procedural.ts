/**
 * 程序化互动反应与指针追踪小服务（移植自 Flutter 同名服务）：
 *   - ClickSequenceService：3秒3次疑惑 / 4秒5次吐槽 / 6秒8次点击冷却
 *   - DragReactionService：快速拖动（≥250px/s）检测
 *   - PointerProximityService：指针位置/速度平滑滤波
 *   - ProceduralReactionService：程序微动（catalog.ts kind=procedural 的动作）的相位动画，
 *     经互动覆盖通道写头部偏移、眼睑、猫耳、脸红
 */

import {
  InteractionTarget,
  type ArmInteractionValues,
  type FaceMicroInteractionValues,
  type InteractionPose,
} from './target';

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

interface ShakeAxisTrack {
  dir: number;
  travel: number;
  oppositeTravel: number;
  reversals: number[];
}

function createShakeAxisTrack(): ShakeAxisTrack {
  return { dir: 0, travel: 0, oppositeTravel: 0, reversals: [] };
}

function resetShakeAxisTrack(track: ShakeAxisTrack): void {
  track.dir = 0;
  track.travel = 0;
  track.oppositeTravel = 0;
  track.reversals.length = 0;
}

export class DragReactionService {
  private static readonly _fastDragSpeedThreshold = 160; // CSS px/秒（兼容高 DPI 下实际鼠标/触控位移尺度）
  private static readonly _shakeMinSpeed = 100;
  private static readonly _shakeMinTravelPx = 12;
  private static readonly _shakeWindowMs = 900;
  private static readonly _shakeCooldownMs = 2500;

  private _dragging = false;
  private _maxSpeedPxPerSec = 0;
  private _shakeX = createShakeAxisTrack();
  private _shakeY = createShakeAxisTrack();
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
    resetShakeAxisTrack(this._shakeX);
    resetShakeAxisTrack(this._shakeY);
    this._shakeDetected = false;
  }

  cancel(): void {
    this._dragging = false;
    this._maxSpeedPxPerSec = 0;
    resetShakeAxisTrack(this._shakeX);
    resetShakeAxisTrack(this._shakeY);
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

  /** 带方向信息的拖动步进（CSS px/s），检测高速与水平/垂直连续快速摇晃。 */
  onDragMotion(vxCssPerSec: number, vyCssPerSec: number, dtSeconds: number): { shakeTriggered: boolean } {
    if (!this._dragging) return { shakeTriggered: false };
    if (Number.isFinite(vxCssPerSec) && Number.isFinite(vyCssPerSec)) {
      this.onDragMove(Math.hypot(vxCssPerSec, vyCssPerSec));
    }
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return { shakeTriggered: false };
    }
    const clampedDt = Math.min(dtSeconds, 0.1);
    const now = performance.now();
    const xTrig = Number.isFinite(vxCssPerSec) && this._stepShakeAxis(this._shakeX, vxCssPerSec, clampedDt, now);
    const yTrig = Number.isFinite(vyCssPerSec) && this._stepShakeAxis(this._shakeY, vyCssPerSec, clampedDt, now);
    if ((xTrig || yTrig) && now - this._lastShakeAtMs >= DragReactionService._shakeCooldownMs) {
      this._lastShakeAtMs = now;
      this._shakeX.reversals.length = 0;
      this._shakeY.reversals.length = 0;
      this._shakeDetected = true;
      return { shakeTriggered: true };
    }
    return { shakeTriggered: false };
  }

  private _stepShakeAxis(track: ShakeAxisTrack, velocity: number, dtSeconds: number, now: number): boolean {
    if (Math.abs(velocity) < DragReactionService._shakeMinSpeed) return false;
    const dir = Math.sign(velocity);
    const step = Math.abs(velocity * dtSeconds);
    if (track.dir === 0) {
      track.dir = dir;
      track.travel = step;
      track.oppositeTravel = 0;
      return false;
    }
    if (dir === track.dir) {
      track.travel += step;
      track.oppositeTravel = 0;
      return false;
    }
    // 反向累积位移达到阈值才计入一次有效摇晃反转，过滤微小抖动
    track.oppositeTravel += step;
    if (track.travel < DragReactionService._shakeMinTravelPx) {
      track.dir = dir;
      track.travel = track.oppositeTravel;
      track.oppositeTravel = 0;
      return false;
    }
    if (track.oppositeTravel < DragReactionService._shakeMinTravelPx) {
      return false;
    }
    track.dir = dir;
    track.travel = track.oppositeTravel;
    track.oppositeTravel = 0;
    track.reversals.push(now);
    while (
      track.reversals.length > 0 &&
      now - track.reversals[0] > DragReactionService._shakeWindowMs
    ) {
      track.reversals.shift();
    }
    return track.reversals.length >= 3;
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
  bodyY?: number;
  bodyZ?: number;
  armL01?: number;
  armL02?: number;
  armR01?: number;
  armR02?: number;
  eyeSmile?: number;
  mouthForm?: number;
  mouthOpen?: number;
  browY?: number;
  browAngle?: number;
  browForm?: number;
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
  bodyY: 0,
  bodyZ: 0,
  armL01: 0,
  armL02: 0,
  armR01: 0,
  armR02: 0,
  eyeSmile: 0,
  mouthForm: 0,
  mouthOpen: 0,
  browY: 0,
  browAngle: 0,
  browForm: 0,
};

type PhaseExtras = Partial<Omit<Phase,
  'durationMs' | 'eyeOpen' | 'headX' | 'headY' | 'headZ' | 'earL' | 'earR' | 'cheek' | 'bodyX' | 'releaseEye'
>>;

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
  releaseEye = false,
  extras?: PhaseExtras
): Phase {
  return {
    durationMs,
    eyeOpen,
    headX,
    headY,
    headZ,
    earL,
    earR,
    cheek,
    bodyX,
    bodyY: extras?.bodyY ?? 0,
    bodyZ: extras?.bodyZ ?? 0,
    armL01: extras?.armL01 ?? 0,
    armL02: extras?.armL02 ?? 0,
    armR01: extras?.armR01 ?? 0,
    armR02: extras?.armR02 ?? 0,
    eyeSmile: extras?.eyeSmile ?? 0,
    mouthForm: extras?.mouthForm ?? 0,
    mouthOpen: extras?.mouthOpen ?? 0,
    browY: extras?.browY ?? 0,
    browAngle: extras?.browAngle ?? 0,
    browForm: extras?.browForm ?? 0,
    releaseEye,
  };
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
  private _bodyY = 0;
  private _bodyZ = 0;
  private _earL = 0;
  private _earR = 0;
  private _cheek = 0;
  private _armL01 = 0;
  private _armL02 = 0;
  private _armR01 = 0;
  private _armR02 = 0;
  private _eyeSmile = 0;
  private _mouthForm = 0;
  private _mouthOpen = 0;
  private _browY = 0;
  private _browAngle = 0;
  private _browForm = 0;
  private _eyeOverrideActive = false;
  private _eyeSide: 'both' | 'left' | 'right' = 'both';
  /** 拖动「拎起」姿态：相位播完后保持末相位，直到下一次 apply/cancel。 */
  private _holding = false;
  private _holdSway = 0;
  private _holdSwayTarget = 0;
  private _holdSwayY = 0;
  private _holdSwayYTarget = 0;
  private _lastHoldVy = 0;
  private _lastHoldBounceMs = 0;
  private _lastTickMs = 0;
  private static readonly _holdDizzyDurationMs = 1800;
  private _holdDizzyActive = false;
  private _holdDizzyStartMs = 0;

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
    return this._phases.length > 0 || this._recovery !== null || this._holding || this._holdDizzyActive;
  }

  get isHolding(): boolean {
    return this._holding;
  }

  get isHoldDizzyActive(): boolean {
    if (!this._holdDizzyActive) return false;
    return performance.now() - this._holdDizzyStartMs < ProceduralReactionService._holdDizzyDurationMs;
  }

  apply(reaction: ProceduralReaction): void {
    const target = this._getTarget();
    if (target == null) return;
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
    const side = (reaction.side ?? 1) >= 0 ? 1 : -1;
    switch (reaction.type) {
      case 'acknowledge': {
        const s = Math.min(1, Math.max(0, reaction.strength));
        const isLeftTouch = reaction.areaId === 'hand' || reaction.areaId === 'shoulder_left';
        const isRightTouch = reaction.areaId === 'tablet' || reaction.areaId === 'shoulder_right';
        const armPeak: PhaseExtras = isLeftTouch
          ? { bodyY: -2.2 * s, bodyZ: -0.6 * s, armR01: -1.8 * s, armR02: -2.4 * s, armL02: -0.8 * s, mouthForm: 0.2 * s }
          : isRightTouch
            ? { bodyY: -2.2 * s, bodyZ: 0.6 * s, armL01: -1.8 * s, armL02: -2.4 * s, armR02: -0.8 * s, mouthForm: 0.2 * s }
            : { bodyY: -2.2 * s, bodyZ: 0.6 * s, armL02: -1.0 * s, armR02: -1.0 * s, mouthForm: 0.2 * s };
        this._start([
          phase(140, 1, 3.5 * s, -3 * s, 2 * s, 0.25 * s, 0.25 * s, 0, 1.8 * s, false, armPeak),
          phase(140, 1, 3.5 * s, -3 * s, 2 * s, -0.15 * s, -0.15 * s, 0, 1.8 * s, false, armPeak),
          phase(280, 1, 0, 0, 0, 0, 0, 0, 0),
        ]);
        break;
      }
      case 'tilt':
        this._start([
          phase(180, 0.85, 8.0, 4.5, -3, -0.35, 0.25, 0, -3.0, false, {
            bodyY: 1.5, bodyZ: -1.6, armL01: -0.8, armR01: 0.8,
            browY: 0.25, browAngle: -0.15, mouthForm: 0.15,
          }),
          phase(320, 0.85, 8.0, 4.5, -3, -0.3, 0.2, 0, -3.0, false, {
            bodyY: 1.5, bodyZ: -1.6, armL01: -0.8, armR01: 0.8,
            browY: 0.25, browAngle: -0.15, mouthForm: 0.15,
          }),
          phase(320, 1.0, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      case 'ear_blink': {
        // 保持 EarChannel 为 0（兼容既有回归契约），猫耳抖动通过 PartImpulseChannel 弹簧触发。
        const left = reaction.areaId === 'ear_left';
        const bodyZ = left ? -1.0 : 1.0;
        const headX = left ? 5.0 : -5.0;
        const bodyX = left ? 2.0 : -2.0;
        this._start([
          phase(120, 0, headX, -2.5, left ? -1.5 : 1.5, 0, 0, 0, bodyX, false, {
            bodyY: -1.5, bodyZ, eyeSmile: 0.35, browY: 0.2, mouthForm: 0.15,
            armL02: -1.2, armR02: -1.2,
          }),
          phase(60, 0, headX * 0.8, -1.8, left ? -1.5 : 1.5, 0, 0, 0, bodyX * 0.8, false, {
            bodyY: -1.0, bodyZ: bodyZ * 0.7, eyeSmile: 0.25, browY: 0.15, mouthForm: 0.15,
            armL02: -0.8, armR02: -0.8,
          }),
          phase(240, 1, 0, 0, 0, 0, 0, 0, 0),
        ]);
        target.triggerPartImpulse?.(left ? 'ear_left' : 'ear_right', 1.0);
        target.triggerPartImpulse?.(left ? 'ear_right' : 'ear_left', 0.3);
        break;
      }
      case 'eyes_widen':
        this._start([
          phase(180, 1.3, 0, 8.0, 0, -0.55, -0.55, 0, 0, false, {
            bodyY: 4.5, armL01: 2.2, armR01: 2.2, armL02: -1.5, armR02: -1.5,
            browY: 0.55, browAngle: -0.25, mouthOpen: 0.3,
          }),
          phase(260, 1.3, 0, 6.5, 0, -0.4, -0.4, 0, 0, false, {
            bodyY: 3.5, armL01: 1.8, armR01: 1.8, armL02: -1.2, armR02: -1.2,
            browY: 0.45, browAngle: -0.2, mouthOpen: 0.22,
          }),
          phase(300, 1.0, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        target.triggerPartImpulse?.('hair_bounce', 0.55);
        break;
      case 'blush': {
        const s = Math.min(1, Math.max(0, reaction.strength));
        const shyPose: PhaseExtras = {
          bodyY: -0.6 * s,
          armL01: -1.4 * s,
          armR01: -1.4 * s,
          armL02: -2.4 * s,
          armR02: -2.4 * s,
          mouthForm: 0.25 * s,
          browForm: 0.25 * s,
        };
        this._start([
          phase(300, 1.0, 0, 0, 0, 0.35 * s, 0.35 * s, 0.85 * s, 0, false, shyPose),
          phase(900, 1.0, 0, 0, 0, 0.35 * s, 0.35 * s, 0.85 * s, 0, false, shyPose),
          phase(700, 1.0, 0, 0, 0, 0, 0, 0.0),
        ]);
        break;
      }
      case 'nuzzle': {
        // 闭眼把头蹭向触点一侧，带一点红晕与收臂猫耳反应。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const z = side * 5 * s;
        this._start([
          phase(240, 0, side * 9.0 * s, -7.5 * s, z, 0.55 * s, 0.55 * s, 0.4 * s, 3.5 * s * side, false, {
            bodyY: -3.2 * s, bodyZ: 1.8 * s * side,
            armL01: -1.8 * s, armR01: -1.8 * s, armL02: -3.0 * s, armR02: -3.0 * s,
            eyeSmile: 0.85 * s, mouthForm: 0.4 * s, browForm: 0.25 * s,
          }),
          phase(520, 0, side * 10.0 * s, -8.5 * s, z * 1.15, 0.6 * s, 0.6 * s, 0.45 * s, 3.5 * s * side, false, {
            bodyY: -3.6 * s, bodyZ: 2.0 * s * side,
            armL01: -1.8 * s, armR01: -1.8 * s, armL02: -3.2 * s, armR02: -3.2 * s,
            eyeSmile: 0.9 * s, mouthForm: 0.45 * s, browForm: 0.25 * s,
          }),
          phase(380, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'flinch': {
        // 被戳脸：缩一下眯眼收臂折耳，再红着脸回来。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(110, 0.35, -6.0 * s * side, 7.5 * s, -1.5 * s, 0.75 * s, 0.75 * s, 0.5 * s, -3.2 * s * side, false, {
            bodyY: -4.5 * s, bodyZ: -1.2 * s * side,
            armL01: -2.6 * s, armR01: -2.6 * s, armL02: -3.4 * s, armR02: -3.4 * s,
            mouthOpen: 0.25 * s, mouthForm: -0.25 * s, browY: 0.35 * s, browForm: 0.35 * s,
          }),
          phase(220, 0.4, -5.0 * s * side, 6.0 * s, -1.5 * s, 0.65 * s, 0.65 * s, 0.6 * s, -2.6 * s * side, false, {
            bodyY: -3.8 * s, bodyZ: -1.0 * s * side,
            armL01: -2.2 * s, armR01: -2.2 * s, armL02: -3.0 * s, armR02: -3.0 * s,
            mouthOpen: 0.15 * s, mouthForm: -0.2 * s, browY: 0.25 * s, browForm: 0.3 * s,
          }),
          phase(450, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        target.triggerPartImpulse?.('hair_bounce', 0.55);
        break;
      }
      case 'tie_tug': {
        // 领带被拽：头被带着往下点，身体前倾、护住胸前，再抬回来。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const tugPose: PhaseExtras = {
          bodyY: -5.5 * s, bodyZ: 0.8 * s,
          armR01: -2.0 * s, armR02: -3.8 * s, armL01: -1.0 * s, armL02: -2.0 * s,
          browY: 0.3 * s, browAngle: 0.25 * s, mouthOpen: 0.18 * s, mouthForm: -0.25 * s,
        };
        this._start([
          phase(150, 1, 0, -11.0 * s, 2 * s, -0.3 * s, -0.3 * s, 0, 2.2 * s, false, tugPose),
          phase(260, 1, 0, -11.0 * s, 2 * s, -0.25 * s, -0.25 * s, 0, 2.2 * s, false, tugPose),
          phase(200, 1, 0, -2.5 * s, 0.5 * s, 0, 0, 0, 0.6 * s, false, { bodyY: -1.2 * s }),
          phase(300, 1, 0, 0, 0, 0, 0),
        ]);
        target.triggerPartImpulse?.('tie', 0.95 * side);
        break;
      }
      case 'leg_pout': {
        // 碰到腿：扭头半眯眼，抱臂折耳，脸微红。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const poutPose: PhaseExtras = {
          bodyY: -2.5 * s, bodyZ: -1.6 * s,
          armL01: -2.8 * s, armR01: -2.2 * s, armL02: -3.8 * s, armR02: -3.0 * s,
          browAngle: 0.35 * s, browY: -0.2 * s, mouthForm: -0.35 * s,
        };
        this._start([
          phase(200, 0.75, -12.0 * s, 4.5 * s, -2 * s, 0.55 * s, 0.55 * s, 0.35 * s, -4.2 * s, false, poutPose),
          phase(600, 0.75, -12.0 * s, 4.5 * s, -2 * s, 0.55 * s, 0.55 * s, 0.35 * s, -4.2 * s, false, poutPose),
          phase(400, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'look_back': {
        // 朝触点一侧回头看（缺省画面左侧，AngleX 负），异侧立耳、眨一下再转回。
        const s = Math.min(1, Math.max(0, reaction.strength));
        const d = (reaction.side ?? -1) >= 0 ? -1 : 1;
        const earL = d > 0 ? -0.45 * s : 0.2 * s;
        const earR = d > 0 ? 0.2 * s : -0.45 * s;
        const backPose: PhaseExtras = {
          bodyY: 1.8 * s, bodyZ: -1.2 * s * d,
          armL01: 1.2 * s * d, armR01: -1.2 * s * d,
          browY: 0.25 * s, mouthOpen: 0.1 * s,
        };
        this._start([
          phase(260, 1, -16.0 * s * d, 4.0 * s, 2.5 * s * d, earL, earR, 0, -5.5 * s * d, false, backPose),
          phase(420, 1, -16.0 * s * d, 4.0 * s, 2.5 * s * d, earL, earR, 0, -5.5 * s * d, false, backPose),
          phase(90, 0, -14.0 * s * d, 3.0 * s, 2 * s * d, earL * 0.7, earR * 0.7, 0, -4.5 * s * d, false, { ...backPose, bodyY: 1.2 * s }),
          phase(110, 1, -12.0 * s * d, 2.5 * s, 2 * s * d, earL * 0.5, earR * 0.5, 0, -3.5 * s * d, true, { ...backPose, bodyY: 0.8 * s }),
          phase(380, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        break;
      }
      case 'landing': {
        // 慢慢放下：落地轻轻蹲顿回弹。
        const s = Math.min(1, Math.max(0, reaction.strength));
        this._start([
          phase(120, 0.75, 0, -8.0 * s, 0, 0.45 * s, 0.45 * s, 0, 0, false, {
            bodyY: -6.0 * s, armL01: 1.8 * s, armR01: 1.8 * s, armL02: -1.5 * s, armR02: -1.5 * s,
            mouthOpen: 0.12 * s,
          }),
          phase(110, 1, 0, 2.5 * s, 0, -0.2 * s, -0.2 * s, 0, 0, true, {
            bodyY: 2.0 * s, armL01: 0.5 * s, armR01: 0.5 * s,
          }),
          phase(220, 1, 0, 0, 0, 0, 0, 0, 0, true),
        ]);
        target.triggerPartImpulse?.('hair_bounce', -0.9);
        break;
      }
    }
    this._holding = false;
    this._eyeOverrideActive = reaction.type !== 'blush' && reaction.type !== 'acknowledge'
      && reaction.type !== 'tie_tug';
  }

  /** 拖动期间保持「被拎起」姿态：睁大眼、微抬头、伸展身体与双臂、立耳；松手由下一个反应平滑接管。 */
  hold(): void {
    const target = this._getTarget();
    if (target == null || this._isPettingActive()) return;
    this._start([phase(220, 1.15, 0, 7.5, 0, -0.22, -0.22, 0, 0, false, {
      bodyY: 5.0, armL01: 2.8, armR01: 2.8, armL02: -2.2, armR02: -2.2,
      browY: 0.45, browAngle: -0.2, mouthOpen: 0.22,
    })]);
    this._holding = true;
    this._holdSway = 0;
    this._holdSwayTarget = 0;
    this._holdSwayY = 0;
    this._holdSwayYTarget = 0;
    this._lastHoldVy = 0;
    this._lastHoldBounceMs = 0;
    this._holdDizzyActive = false;
    this._holdDizzyStartMs = 0;
    this._lastTickMs = performance.now();
    target.triggerPartImpulse?.('hair_bounce', 0.7);
  }

  /** 拖动中快速往返摇晃触发被转晕的身体与头部摇晃，保持拎起姿态。 */
  triggerHoldDizzy(): void {
    if (!this._holding || this._isPettingActive()) return;
    this._holdDizzyActive = true;
    this._holdDizzyStartMs = performance.now();
    this._getTarget()?.triggerPartImpulse?.('hair_bounce', 0.65);
  }

  /** 摇晃转晕后松手：结束拎起姿态并平滑落地，同时保留进行中的转晕摇晃。 */
  releaseHoldAfterShake(): void {
    const target = this._getTarget();
    if (target == null || !this._holding || this._isPettingActive()) return;
    this._holding = false;
    this._start([
      phase(120, 0.85, 0, -5.0, 0, 0.35, 0.35, 0, 0, false, {
        bodyY: -4.0, armL01: 1.2, armR01: 1.2, armL02: -1.0, armR02: -1.0,
      }),
      phase(260, 1, 0, 0, 0, 0, 0, 0, 0, true),
    ], true);
    this._eyeOverrideActive = false;
    target.triggerPartImpulse?.('hair_bounce', -0.75);
  }

  private _holdDizzyPose(now: number): {
    env: number;
    headX: number; headY: number; headZ: number;
    bodyX: number; bodyY: number; bodyZ: number;
    armL01: number; armL02: number; armR01: number; armR02: number;
    earL: number; earR: number;
  } {
    if (!this._holdDizzyActive) {
      return {
        env: 0,
        headX: 0, headY: 0, headZ: 0,
        bodyX: 0, bodyY: 0, bodyZ: 0,
        armL01: 0, armL02: 0, armR01: 0, armR02: 0,
        earL: 0, earR: 0,
      };
    }
    const elapsedMs = now - this._holdDizzyStartMs;
    if (elapsedMs < 0 || elapsedMs >= ProceduralReactionService._holdDizzyDurationMs) {
      this._holdDizzyActive = false;
      return {
        env: 0,
        headX: 0, headY: 0, headZ: 0,
        bodyX: 0, bodyY: 0, bodyZ: 0,
        armL01: 0, armL02: 0, armR01: 0, armR02: 0,
        earL: 0, earR: 0,
      };
    }
    const t = elapsedMs / 1000;
    const inK = Math.min(1, t / 0.12);
    const inEnv = inK * inK * (3 - 2 * inK);
    const outK = 1 - Math.min(1, elapsedMs / ProceduralReactionService._holdDizzyDurationMs);
    const env = inEnv * outK * outK;
    const phase = 2 * Math.PI * 2.4 * t;
    const bodySin = Math.sin(phase);
    const bodyCos = Math.cos(phase);
    const headSin = Math.sin(phase - 0.55);
    const headCos = Math.cos(phase - 0.55);
    const armSin = Math.sin(phase - 0.35);
    const armCos = Math.cos(phase - 0.35);
    const earSin = Math.sin(phase - 0.7);
    return {
      env,
      bodyZ: bodySin * 5.2 * env,
      bodyX: bodyCos * 4.8 * env,
      bodyY: (-1.8 + Math.sin(phase * 2) * 2.0) * env,
      headZ: headSin * 9.5 * env,
      headX: headCos * 10.5 * env,
      headY: (-3.0 + Math.cos(phase * 2 - 0.4) * 3.2) * env,
      armL01: armSin * 2.4 * env,
      armR01: -armSin * 2.4 * env,
      armL02: armCos * 1.4 * env,
      armR02: -armCos * 1.4 * env,
      earL: earSin * 0.25 * env,
      earR: -earSin * 0.25 * env,
    };
  }

  /** 拖动时头身按惯性反向轻摆；vx 为模型空间水平速度（+ = 模型右），vy 为画面垂直速度（+ = 向下）。 */
  setHoldSway(vxPxPerSec: number, vyPxPerSec = 0): void {
    if (!this._holding) return;
    if (Number.isFinite(vxPxPerSec)) {
      this._holdSwayTarget = Math.max(-6, Math.min(6, -vxPxPerSec / 600 * 5));
    }
    if (Number.isFinite(vyPxPerSec)) {
      this._holdSwayYTarget = Math.max(-6, Math.min(6, vyPxPerSec / 450 * 6));
      const now = performance.now();
      const dv = vyPxPerSec - this._lastHoldVy;
      const reversed = this._lastHoldVy !== 0 && Math.sign(vyPxPerSec) !== Math.sign(this._lastHoldVy);
      if ((reversed || Math.abs(dv) > 220) && Math.abs(vyPxPerSec) > 140 && now - this._lastHoldBounceMs >= 130) {
        this._lastHoldBounceMs = now;
        const amp = Math.max(-0.85, Math.min(0.85, vyPxPerSec / 800));
        this._getTarget()?.triggerPartImpulse?.('hair_bounce', amp);
      }
      this._lastHoldVy = vyPxPerSec;
    }
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
    this._holdSwayY = this._holdSwayYTarget = 0;
    this._lastHoldVy = 0;
    this._lastHoldBounceMs = 0;
    this._holdDizzyActive = false;
    this._holdDizzyStartMs = 0;
    this._phases.length = 0;
    this._recovery = null;
    this._phaseIndex = 0;
    this._eyeOverrideActive = false;
    this._eyeOpen = 1;
    this._headX = this._headY = this._headZ = this._bodyX = this._bodyY = this._bodyZ = 0;
    this._earL = this._earR = this._cheek = 0;
    this._armL01 = this._armL02 = this._armR01 = this._armR02 = 0;
    this._eyeSmile = this._mouthForm = this._mouthOpen = this._browY = this._browAngle = this._browForm = 0;
    const target = this._getTarget();
    if (target) {
      try {
        target.setInteractionOffsets(0, 0, 0, 0);
        target.setBodyTilt?.(0, 0);
        target.setEyeOverride(false, 0, 0);
        target.setEarInteraction(false, 0, 0);
        target.setFaceCheek(false, 0);
        target.setArmInteraction?.(false);
        target.setFaceMicroInteraction?.(false);
      } catch {
        // 忽略
      }
    }
  }

  private _start(phases: Phase[], keepDizzy = false): void {
    // 恢复期内再次点击，从上一帧实际输出重新交接，不能回退到旧抚摸姿态。
    if (this._recovery) {
      this._recovery.from = this._recovery.current;
      this._recovery.startMs = performance.now();
    }
    // 拎起摆动（以及未保留时的转晕摇晃）并入可见姿态后再交接，松手反应从当前姿态继续而非跳回。
    const now = performance.now();
    const dizzy = keepDizzy
      ? { env: 0, headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0, armL01: 0, armL02: 0, armR01: 0, armR02: 0, earL: 0, earR: 0 }
      : this._holdDizzyPose(now);
    const swayYAbs = Math.abs(this._holdSwayY);
    const earScale = this._holding ? 1 - Math.min(1, Math.hypot(this._holdSway, this._holdSwayY) / 6) * 0.75 : 1;
    this._headX += this._holdSway * 1.5 + dizzy.headX;
    this._headY += this._holdSwayY * 2.2 + dizzy.headY;
    this._headZ += this._holdSway + dizzy.headZ;
    this._bodyX += this._holdSway * 0.55 + dizzy.bodyX;
    this._bodyY += this._holdSwayY * 0.9 + dizzy.bodyY;
    this._bodyZ += this._holdSway * 0.35 + dizzy.bodyZ;
    this._armL01 += this._holdSway * 0.32 + this._holdSwayY * 0.85 + dizzy.armL01;
    this._armL02 += this._holdSwayY * 0.45 + dizzy.armL02;
    this._armR01 += -this._holdSway * 0.32 + this._holdSwayY * 0.85 + dizzy.armR01;
    this._armR02 += this._holdSwayY * 0.45 + dizzy.armR02;
    this._earL = this._earL * earScale + this._holdSway * 0.06 - this._holdSwayY * 0.05 + dizzy.earL;
    this._earR = this._earR * earScale - this._holdSway * 0.06 - this._holdSwayY * 0.05 + dizzy.earR;
    this._mouthOpen += swayYAbs * 0.04;
    this._browY = this._browY * (1 - dizzy.env) + swayYAbs * 0.04;
    this._browAngle *= 1 - dizzy.env;
    this._holdSway = this._holdSwayTarget = 0;
    this._holdSwayY = this._holdSwayYTarget = 0;
    this._lastHoldVy = 0;
    this._lastHoldBounceMs = 0;
    if (!keepDizzy) {
      this._holdDizzyActive = false;
      this._holdDizzyStartMs = 0;
    }
    this._phases = phases.length > 0 ? [...phases] : [NEUTRAL];
    this._phaseIndex = 0;
    this._phaseStartMs = now;
    this._prev = {
      durationMs: 0,
      eyeOpen: this._eyeOpen,
      headX: this._headX,
      headY: this._headY,
      headZ: this._headZ,
      earL: this._earL,
      earR: this._earR,
      cheek: this._cheek,
      bodyX: this._bodyX,
      bodyY: this._bodyY,
      bodyZ: this._bodyZ,
      armL01: this._armL01,
      armL02: this._armL02,
      armR01: this._armR01,
      armR02: this._armR02,
      eyeSmile: this._eyeSmile,
      mouthForm: this._mouthForm,
      mouthOpen: this._mouthOpen,
      browY: this._browY,
      browAngle: this._browAngle,
      browForm: this._browForm,
    };
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
      const swayK = 1 - Math.exp(-dt / 0.12);
      const decay = Math.exp(-dt / 0.25);
      this._holdSway += (this._holdSwayTarget - this._holdSway) * swayK;
      this._holdSwayTarget *= decay;
      this._holdSwayY += (this._holdSwayYTarget - this._holdSwayY) * swayK;
      this._holdSwayYTarget *= decay;
    }
    if (this._holding && this._phaseIndex >= this._phases.length) {
      // 保持末相位，不回中性。
    } else if (this._phaseIndex >= this._phases.length) {
      // 已结束：回到中性
      this._eyeOpen = 1;
      this._headX = this._headY = this._headZ = this._bodyX = this._bodyY = this._bodyZ = 0;
      this._earL = this._earR = this._cheek = 0;
      this._armL01 = this._armL02 = this._armR01 = this._armR02 = 0;
      this._eyeSmile = this._mouthForm = this._mouthOpen = this._browY = this._browAngle = this._browForm = 0;
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
      const lerp = (a: number | undefined, b: number | undefined) => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * k;
      this._eyeOpen = this._prev.eyeOpen + (p.eyeOpen - this._prev.eyeOpen) * k;
      this._headX = this._prev.headX + (p.headX - this._prev.headX) * k;
      this._headY = this._prev.headY + (p.headY - this._prev.headY) * k;
      this._headZ = this._prev.headZ + (p.headZ - this._prev.headZ) * k;
      this._bodyX = this._prev.bodyX + (p.bodyX - this._prev.bodyX) * k;
      this._bodyY = lerp(this._prev.bodyY, p.bodyY);
      this._bodyZ = lerp(this._prev.bodyZ, p.bodyZ);
      this._earL = this._prev.earL + (p.earL - this._prev.earL) * k;
      this._earR = this._prev.earR + (p.earR - this._prev.earR) * k;
      this._cheek = this._prev.cheek + (p.cheek - this._prev.cheek) * k;
      this._armL01 = lerp(this._prev.armL01, p.armL01);
      this._armL02 = lerp(this._prev.armL02, p.armL02);
      this._armR01 = lerp(this._prev.armR01, p.armR01);
      this._armR02 = lerp(this._prev.armR02, p.armR02);
      this._eyeSmile = lerp(this._prev.eyeSmile, p.eyeSmile);
      this._mouthForm = lerp(this._prev.mouthForm, p.mouthForm);
      this._mouthOpen = lerp(this._prev.mouthOpen, p.mouthOpen);
      this._browY = lerp(this._prev.browY, p.browY);
      this._browAngle = lerp(this._prev.browAngle, p.browAngle);
      this._browForm = lerp(this._prev.browForm, p.browForm);

      if (k >= 1.0) {
        this._prev = p;
        this._phaseIndex++;
        this._phaseStartMs = now;
      }
    }

    // 只由本服务写通道：从抚摸的最后一帧平滑混入新反应，而非先清零。
    const dizzy = this._holdDizzyPose(now);
    const sway = this._holdSway;
    const swayY = this._holdSwayY;
    const swayYAbs = Math.abs(swayY);
    const earScale = this._holding ? 1 - Math.min(1, Math.hypot(sway, swayY) / 6) * 0.75 : 1;
    const armsOut: ArmInteractionValues = {
      armL01: this._armL01 + sway * 0.32 + swayY * 0.85 + dizzy.armL01,
      armL02: this._armL02 + swayY * 0.45 + dizzy.armL02,
      armR01: this._armR01 - sway * 0.32 + swayY * 0.85 + dizzy.armR01,
      armR02: this._armR02 + swayY * 0.45 + dizzy.armR02,
    };
    const microOut: FaceMicroInteractionValues = {
      eyeSmile: this._eyeSmile,
      mouthForm: this._mouthForm,
      mouthOpen: this._mouthOpen + swayYAbs * 0.04,
      browY: this._browY * (1 - dizzy.env) + swayYAbs * 0.04,
      browAngle: this._browAngle * (1 - dizzy.env),
      browForm: this._browForm,
    };
    let output: InteractionPose = {
      headX: this._headX + sway * 1.5 + dizzy.headX,
      headY: this._headY + swayY * 2.2 + dizzy.headY,
      headZ: this._headZ + sway + dizzy.headZ,
      bodyX: this._bodyX + sway * 0.55 + dizzy.bodyX,
      bodyY: this._bodyY + swayY * 0.9 + dizzy.bodyY,
      bodyZ: this._bodyZ + sway * 0.35 + dizzy.bodyZ,
      eyeEnabled: this._eyeOverrideActive,
      eyeLeft: this._eyeOpen,
      eyeRight: this._eyeOpen,
      earL: this._earL * earScale + sway * 0.06 - swayY * 0.05 + dizzy.earL,
      earR: this._earR * earScale - sway * 0.06 - swayY * 0.05 + dizzy.earR,
      cheek: this._cheek,
      arms: armsOut,
      faceMicro: microOut,
    };
    let side = this._eyeSide;
    if (this._recovery) {
      const { from, startMs } = this._recovery;
      const rt = Math.min(Math.max((now - startMs) / 360, 0), 1);
      const rk = rt * rt * (3 - 2 * rt);
      const blend = (a: number, b: number) => a + (b - a) * rk;
      output = {
        headX: blend(from.headX, output.headX),
        headY: blend(from.headY, output.headY),
        headZ: blend(from.headZ, output.headZ),
        bodyX: blend(from.bodyX, output.bodyX),
        bodyY: blend(from.bodyY ?? 0, output.bodyY ?? 0),
        bodyZ: blend(from.bodyZ ?? 0, output.bodyZ ?? 0),
        eyeEnabled: output.eyeEnabled || (from.eyeEnabled && rt < 1),
        eyeLeft: blend(from.eyeEnabled ? from.eyeLeft : 1,
          output.eyeEnabled && side !== 'right' ? this._eyeOpen : 1),
        eyeRight: blend(from.eyeEnabled ? from.eyeRight : 1,
          output.eyeEnabled && side !== 'left' ? this._eyeOpen : 1),
        earL: blend(from.earL ?? 0, output.earL ?? 0),
        earR: blend(from.earR ?? 0, output.earR ?? 0),
        cheek: blend(from.cheek ?? 0, output.cheek ?? 0),
        arms: {
          armL01: blend(from.arms?.armL01 ?? 0, armsOut.armL01),
          armL02: blend(from.arms?.armL02 ?? 0, armsOut.armL02),
          armR01: blend(from.arms?.armR01 ?? 0, armsOut.armR01),
          armR02: blend(from.arms?.armR02 ?? 0, armsOut.armR02),
        },
        faceMicro: {
          eyeSmile: blend(from.faceMicro?.eyeSmile ?? 0, microOut.eyeSmile ?? 0),
          mouthForm: blend(from.faceMicro?.mouthForm ?? 0, microOut.mouthForm ?? 0),
          mouthOpen: blend(from.faceMicro?.mouthOpen ?? 0, microOut.mouthOpen ?? 0),
          browY: blend(from.faceMicro?.browY ?? 0, microOut.browY ?? 0),
          browAngle: blend(from.faceMicro?.browAngle ?? 0, microOut.browAngle ?? 0),
          browForm: blend(from.faceMicro?.browForm ?? 0, microOut.browForm ?? 0),
        },
      };
      // 另一只眼只平滑睁开，不跟随耳朵点击再次闭眼。
      if (from.eyeEnabled && rt < 1) side = 'both';
      this._recovery.current = output;
      if (rt >= 1) this._recovery = null;
    }
    try {
      target.setInteractionOffsets(
        output.headX,
        output.headY,
        output.headZ,
        output.bodyX
      );
      target.setBodyTilt?.(output.bodyY ?? 0, output.bodyZ ?? 0);
      if (output.eyeEnabled) {
        target.setEyeOverride(true, output.eyeLeft, output.eyeRight, side);
      } else {
        target.setEyeOverride(false, 0, 0);
      }
      const earL = output.earL ?? this._earL;
      const earR = output.earR ?? this._earR;
      target.setEarInteraction(earL !== 0 || earR !== 0, earL, earR);
      const cheek = output.cheek ?? this._cheek;
      target.setFaceCheek(cheek !== 0, cheek);

      const arms = output.arms ?? armsOut;
      const armActive = arms.armL01 !== 0 || arms.armL02 !== 0 || arms.armR01 !== 0 || arms.armR02 !== 0;
      target.setArmInteraction?.(armActive, arms);

      const micro = output.faceMicro ?? microOut;
      const microActive = (micro.eyeSmile ?? 0) !== 0 || (micro.mouthForm ?? 0) !== 0 ||
        (micro.mouthOpen ?? 0) !== 0 || (micro.browY ?? 0) !== 0 ||
        (micro.browAngle ?? 0) !== 0 || (micro.browForm ?? 0) !== 0;
      target.setFaceMicroInteraction?.(microActive, micro);
    } catch {
      // 写入失败忽略
    }
  }
}
