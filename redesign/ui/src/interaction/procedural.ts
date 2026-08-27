/**
 * 程序化互动反应与指针追踪小服务（移植自 Flutter 同名服务，逻辑等价）：
 *   - ClickSequenceService：3秒3次疑惑 / 4秒5次吐槽 / 6秒8次点击冷却
 *   - DragReactionService：快速拖动（≥250px/s）检测
 *   - PointerProximityService：指针位置/速度平滑滤波
 *   - ProceduralReactionService：点击 head（闭眼+头倾）、face（脸红）、
 *     耳朵（小幅耳动）、快速拖动（睁大）、连续点击（疑惑）的相位动画
 */

import { InteractionTarget } from './target';

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
  private _cooldownUntilMs = 0;

  get isInCooldown(): boolean {
    return performance.now() < this._cooldownUntilMs;
  }

  registerClick(): ClickResult {
    const now = performance.now();
    this._clicks.push(now);
    while (this._clicks.length > 0 && now - this._clicks[0] > 6000) {
      this._clicks.shift();
    }

    if (this.isInCooldown) return ClickResult.cooldown;

    if (this._countWithin(now, 6) >= 8) {
      this._cooldownUntilMs = now + (Math.floor(Math.random() * 4) + 2) * 1000;
      return ClickResult.cooldown;
    }
    if (this._countWithin(now, 5) >= 4) return ClickResult.comment;
    if (this._countWithin(now, 3) >= 3) return ClickResult.doubt;
    return ClickResult.none;
  }

  reset(): void {
    this._clicks.length = 0;
    this._cooldownUntilMs = 0;
  }

  private _countWithin(now: number, seconds: number): number {
    let count = 0;
    for (let i = this._clicks.length - 1; i >= 0; i--) {
      if (now - this._clicks[i] <= seconds * 1000) count++;
      else break;
    }
    return count;
  }
}

// ---------- 快速拖动检测 ----------

export class DragReactionService {
  private static readonly _fastDragSpeedThreshold = 250; // 物理像素/秒

  private _dragging = false;
  private _maxSpeedPxPerSec = 0;

  get isDragging(): boolean {
    return this._dragging;
  }

  beginDrag(): void {
    this._dragging = true;
    this._maxSpeedPxPerSec = 0;
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

export type ProceduralReactionType =
  | 'headTiltAndEyes'
  | 'lookAtThenAway'
  | 'earTwitch'
  | 'eyesWiden'
  | 'doubt'
  | 'blush';

export interface ProceduralReaction {
  type: ProceduralReactionType;
  strength: number;
  areaId?: string;
}

export const ProceduralReactions = {
  eyesAndTilt: (strength: number): ProceduralReaction => ({
    type: 'headTiltAndEyes',
    strength,
  }),
  earTwitch: (strength: number, areaId: string): ProceduralReaction => ({
    type: 'earTwitch',
    strength,
    areaId,
  }),
  eyesWiden: (strength: number): ProceduralReaction => ({
    type: 'eyesWiden',
    strength,
  }),
  doubt: (strength: number): ProceduralReaction => ({
    type: 'doubt',
    strength,
  }),
  blush: (strength: number): ProceduralReaction => ({
    type: 'blush',
    strength,
  }),
};

interface Phase {
  durationMs: number;
  eyeOpen: number;
  headX: number;
  headY: number;
  headZ: number;
  earL: number;
  earR: number;
  cheek: number;
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
};

function phase(
  durationMs: number,
  eyeOpen: number,
  headX: number,
  headY: number,
  headZ: number,
  earL: number,
  earR: number,
  cheek = 0
): Phase {
  return { durationMs, eyeOpen, headX, headY, headZ, earL, earR, cheek };
}

/**
 * 相位动画反应服务。每帧由渲染循环驱动 tick()。
 * 抚摸模式期间不叠加程序化反应（apply 直接忽略）。
 */
export class ProceduralReactionService {
  private readonly _getTarget: () => InteractionTarget | null;
  private readonly _isPettingActive: () => boolean;
  private readonly _playCharacterAction: (action: string) => boolean;

  private _phases: Phase[] = [];
  private _phaseIndex = 0;
  private _phaseStartMs = 0;
  private _prev: Phase = NEUTRAL;

  private _eyeOpen = 1;
  private _headX = 0;
  private _headY = 0;
  private _headZ = 0;
  private _earL = 0;
  private _earR = 0;
  private _cheek = 0;
  private _eyeOverrideActive = false;

  constructor(deps: {
    getTarget: () => InteractionTarget | null;
    isPettingActive: () => boolean;
    playCharacterAction: (action: string) => boolean;
  }) {
    this._getTarget = deps.getTarget;
    this._isPettingActive = deps.isPettingActive;
    this._playCharacterAction = deps.playCharacterAction;
  }

  get isPlaying(): boolean {
    return this._phases.length > 0;
  }

  apply(reaction: ProceduralReaction): void {
    if (this._isPettingActive()) return;
    if (this._getTarget() == null) return;

    switch (reaction.type) {
      case 'headTiltAndEyes':
        this._start([
          phase(180, 0.85, 2.5, 0, -3, 0, 0),
          phase(320, 0.85, 2.5, 0, -3, 0, 0),
          phase(320, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case 'lookAtThenAway':
        this._start([
          phase(180, 1.0, 0, 1.8, 0, 0, 0),
          phase(300, 1.0, 0, 1.8, 0, 0, 0),
          phase(300, 1.0, 0, -1.2, 0, 0, 0),
        ]);
        break;
      case 'earTwitch': {
        const left = reaction.areaId === 'ear_left';
        this._start([
          phase(120, 1.0, 0, 0, left ? -1.5 : 1.5, left ? 0.8 : 0, left ? 0 : 0.8),
          phase(200, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      }
      case 'eyesWiden':
        this._start([
          phase(180, 1.3, 0, 0, 0, 0, 0),
          phase(260, 1.3, 0, 0, 0, 0, 0),
          phase(300, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case 'doubt':
        this._playCharacterAction('doubt');
        this._start([
          phase(200, 0.4, -3, 0, 4, 0, 0),
          phase(400, 0.45, -3, 0, 4, 0, 0),
          phase(300, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case 'blush':
        this._start([
          phase(300, 1.0, 0, 0, 0, 0, 0, 0.55 * reaction.strength),
          phase(900, 1.0, 0, 0, 0, 0, 0, 0.55 * reaction.strength),
          phase(700, 1.0, 0, 0, 0, 0, 0, 0.0),
        ]);
        break;
    }
  }

  cancelAll(): void {
    this._phases.length = 0;
    this._phaseIndex = 0;
    this._eyeOverrideActive = false;
    this._eyeOpen = 1;
    this._headX = this._headY = this._headZ = this._earL = this._earR = 0;
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
    this._phases = phases.length > 0 ? [...phases] : [NEUTRAL];
    this._phaseIndex = 0;
    this._phaseStartMs = performance.now();
    this._prev = NEUTRAL;
    this._eyeOverrideActive = true;
  }

  /** 每帧驱动（由渲染循环调用）。 */
  tick(): void {
    const target = this._getTarget();
    if (!target) return;
    if (this._phases.length === 0) return;

    const now = performance.now();
    const t = (now - this._phaseStartMs) / 1000;
    if (this._phaseIndex >= this._phases.length) {
      // 已结束：回到中性
      this._eyeOpen = 1;
      this._headX = this._headY = this._headZ = this._earL = this._earR = 0;
      this._cheek = 0;
      this._eyeOverrideActive = false;
      this._phases.length = 0;
    } else {
      const p = this._phases[this._phaseIndex];
      const k = Math.min(
        Math.max(t / Math.max(p.durationMs / 1000, 0.001), 0),
        1
      );
      this._eyeOpen = this._prev.eyeOpen + (p.eyeOpen - this._prev.eyeOpen) * k;
      this._headX = this._prev.headX + (p.headX - this._prev.headX) * k;
      this._headY = this._prev.headY + (p.headY - this._prev.headY) * k;
      this._headZ = this._prev.headZ + (p.headZ - this._prev.headZ) * k;
      this._earL = this._prev.earL + (p.earL - this._prev.earL) * k;
      this._earR = this._prev.earR + (p.earR - this._prev.earR) * k;
      this._cheek = this._prev.cheek + (p.cheek - this._prev.cheek) * k;

      if (k >= 1.0) {
        this._prev = p;
        this._phaseIndex++;
        this._phaseStartMs = now;
      }
    }

    try {
      target.setInteractionOffsets(this._headX, this._headY, this._headZ, 0);
      if (this._eyeOverrideActive) {
        target.setEyeOverride(true, this._eyeOpen, this._eyeOpen);
      } else {
        target.setEyeOverride(false, 0, 0);
      }
      target.setEarInteraction(
        this._earL !== 0 || this._earR !== 0,
        this._earL,
        this._earR
      );
      target.setFaceCheek(this._cheek !== 0, this._cheek);
    } catch {
      // 写入失败忽略
    }
  }
}
