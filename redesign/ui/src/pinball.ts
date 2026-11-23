/**
 * 弹球模式 2D 重力碰撞物理：
 * 开启弹球模式后，用力甩出桌宠将保持原本大小与直立姿态，
 * 按真实重力抛物线运动并在当前屏幕工作区四壁间连续弹性碰撞反弹，
 * 多次弹跳后在底边滑行刹停。
 */

export interface PinballBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export type PinballWall = 'left' | 'right' | 'top' | 'bottom';

export interface PinballBounceEvent {
  wall: PinballWall;
  impactSpeed: number;
  count: number;
}

export interface PinballLaunchOptions {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounds: PinballBounds;
  onBounce?: (event: PinballBounceEvent) => void;
  onSettled?: (x: number, y: number) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export class PinballPhysics {
  static readonly MIN_LAUNCH_SPEED = 140;
  static readonly MAX_SPEED = 3600;
  static readonly LAUNCH_GAIN = 1.45;
  static readonly GRAVITY = 1600;
  static readonly AIR_DRAG = 0.15;
  static readonly GROUND_DRAG = 2.2;
  static readonly GROUND_HIT_FRICTION = 0.96;
  static readonly RESTITUTION_X = 0.90;
  static readonly RESTITUTION_Y = 0.88;
  static readonly GROUND_BOUNCE_MIN_VY = 120;
  static readonly STOP_SPEED = 25;
  static readonly SQUASH_MAX_Y = 0.16;
  static readonly SQUASH_MAX_X = 0.09;
  private static readonly _SUBSTEP_DT = 1 / 240;
  private static readonly _SQUASH_HZ = 4.2;
  private static readonly _SQUASH_ZETA = 0.45;
  private static readonly _SQUASH_REF_SPEED = 950;

  active = false;
  bouncing = false;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  bounceCount = 0;
  squash = 0;

  private _squashVel = 0;
  private _bounds: PinballBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private _onBounce: ((event: PinballBounceEvent) => void) | null = null;
  private _onSettled: ((x: number, y: number) => void) | null = null;

  get squashActive(): boolean {
    return Math.abs(this.squash) > 0.002 || Math.abs(this._squashVel) > 0.02;
  }

  get squashScale(): { sx: number; sy: number } {
    const s = clamp(this.squash, -0.35, 1.15);
    return {
      sx: 1 + PinballPhysics.SQUASH_MAX_X * s,
      sy: 1 - PinballPhysics.SQUASH_MAX_Y * s,
    };
  }

  canLaunch(vxCss: number, vyCss: number): boolean {
    return Number.isFinite(vxCss) && Number.isFinite(vyCss)
      && Math.hypot(vxCss, vyCss) >= PinballPhysics.MIN_LAUNCH_SPEED;
  }

  launch(opts: PinballLaunchOptions): boolean {
    if (!this.canLaunch(opts.vx, opts.vy)) return false;
    const minX = Math.min(opts.bounds.minX, opts.bounds.maxX);
    const maxX = Math.max(opts.bounds.minX, opts.bounds.maxX);
    const minY = Math.min(opts.bounds.minY, opts.bounds.maxY);
    const maxY = Math.max(opts.bounds.minY, opts.bounds.maxY);
    this._bounds = { minX, maxX, minY, maxY };

    let vx = opts.vx * PinballPhysics.LAUNCH_GAIN;
    let vy = opts.vy * PinballPhysics.LAUNCH_GAIN;
    const speed = Math.hypot(vx, vy);
    if (speed > PinballPhysics.MAX_SPEED) {
      const k = PinballPhysics.MAX_SPEED / speed;
      vx *= k;
      vy *= k;
    }

    let x = opts.x;
    let y = opts.y;
    if (x < minX) {
      x = minX;
      if (vx < 0) vx = -vx * PinballPhysics.RESTITUTION_X;
    } else if (x > maxX) {
      x = maxX;
      if (vx > 0) vx = -vx * PinballPhysics.RESTITUTION_X;
    }
    if (y < minY) {
      y = minY;
      if (vy < 0) vy = -vy * PinballPhysics.RESTITUTION_Y;
    } else if (y > maxY) {
      y = maxY;
      if (vy > 0) vy = -vy * PinballPhysics.RESTITUTION_Y;
    }

    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.active = true;
    this.bouncing = true;
    this.bounceCount = 0;
    this.squash = 0;
    this._squashVel = 0;
    this._onBounce = opts.onBounce ?? null;
    this._onSettled = opts.onSettled ?? null;
    return true;
  }

  /** 立即停止运动（就地停住，不旋转；自然落地时保留收尾压扁回弹）。 */
  stopBouncing(preserveSquash = false): void {
    if (!this.active) return;
    this.bouncing = false;
    this.vx = 0;
    this.vy = 0;
    this.active = false;
    if (!preserveSquash) {
      this.squash = 0;
      this._squashVel = 0;
    }
    const settled = this._onSettled;
    this._onSettled = null;
    this._onBounce = null;
    settled?.(this.x, this.y);
  }

  cancel(): void {
    this.active = false;
    this.bouncing = false;
    this.vx = 0;
    this.vy = 0;
    this.bounceCount = 0;
    this.squash = 0;
    this._squashVel = 0;
    this._onBounce = null;
    this._onSettled = null;
  }

  stepSquash(dtSec: number): void {
    if (!this.squashActive) return;
    const dt = Math.min(0.05, Math.max(0, Number.isFinite(dtSec) ? dtSec : 0));
    if (dt === 0) return;
    const steps = Math.max(1, Math.ceil(dt / PinballPhysics._SUBSTEP_DT));
    const subDt = dt / steps;
    const omega = 2 * Math.PI * PinballPhysics._SQUASH_HZ;
    const zeta = PinballPhysics._SQUASH_ZETA;
    for (let i = 0; i < steps; i++) {
      this._squashVel += (-omega * omega * this.squash - 2 * zeta * omega * this._squashVel) * subDt;
      this.squash += this._squashVel * subDt;
      if (Math.abs(this.squash) < 0.002 && Math.abs(this._squashVel) < 0.02) {
        this.squash = 0;
        this._squashVel = 0;
        break;
      }
    }
  }

  step(dtSec: number): void {
    if (!this.active || !this.bouncing) return;
    const dt = Math.min(0.05, Math.max(0, Number.isFinite(dtSec) ? dtSec : 0));
    if (dt === 0) return;

    const steps = Math.max(1, Math.ceil(dt / PinballPhysics._SUBSTEP_DT));
    const subDt = dt / steps;
    const airDamp = Math.exp(-PinballPhysics.AIR_DRAG * subDt);
    const groundDamp = Math.exp(-PinballPhysics.GROUND_DRAG * subDt);
    const { minX, maxX, minY, maxY } = this._bounds;

    for (let i = 0; i < steps; i++) {
      const groundedBefore = this.y >= maxY - 0.5 && Math.abs(this.vy) < 1;
      if (!groundedBefore) {
        this.vy += PinballPhysics.GRAVITY * subDt;
        this.vx *= airDamp;
        this.vy *= airDamp;
      } else {
        this.vy = 0;
        this.vx *= groundDamp;
      }

      this.x += this.vx * subDt;
      this.y += this.vy * subDt;

      if (maxX <= minX) {
        this.x = minX;
        this.vx = 0;
      } else if (this.x < minX) {
        const impact = Math.abs(this.vx);
        this.x = clamp(minX + (minX - this.x) * PinballPhysics.RESTITUTION_X, minX, maxX);
        this.vx = Math.abs(this.vx) * PinballPhysics.RESTITUTION_X;
        this._emitBounce('left', impact);
      } else if (this.x > maxX) {
        const impact = Math.abs(this.vx);
        this.x = clamp(maxX - (this.x - maxX) * PinballPhysics.RESTITUTION_X, minX, maxX);
        this.vx = -Math.abs(this.vx) * PinballPhysics.RESTITUTION_X;
        this._emitBounce('right', impact);
      }

      if (maxY <= minY) {
        this.y = minY;
        this.vy = 0;
      } else if (this.y < minY) {
        const impact = Math.abs(this.vy);
        this.y = clamp(minY + (minY - this.y) * PinballPhysics.RESTITUTION_Y, minY, maxY);
        this.vy = Math.abs(this.vy) * PinballPhysics.RESTITUTION_Y;
        this._emitBounce('top', impact);
      } else if (this.y > maxY) {
        const impact = Math.abs(this.vy);
        if (impact >= PinballPhysics.GROUND_BOUNCE_MIN_VY) {
          this.y = clamp(maxY - (this.y - maxY) * PinballPhysics.RESTITUTION_Y, minY, maxY);
          this.vy = -impact * PinballPhysics.RESTITUTION_Y;
          this.vx *= PinballPhysics.GROUND_HIT_FRICTION;
          this._applyBottomSquash(impact);
          this._emitBounce('bottom', impact);
        } else {
          if (impact >= 40) this._applyBottomSquash(impact);
          this.y = maxY;
          this.vy = 0;
        }
      }
    }

    this.stepSquash(dt);

    const onFloor = maxY <= minY || this.y >= maxY - 0.5;
    if (onFloor && Math.abs(this.vy) < 1 && Math.abs(this.vx) < PinballPhysics.STOP_SPEED) {
      this.y = maxY;
      this.stopBouncing(true);
    }
  }

  private _applyBottomSquash(impactSpeed: number): void {
    const k = clamp(impactSpeed / PinballPhysics._SQUASH_REF_SPEED, 0.25, 1);
    this.squash = Math.min(1.15, Math.max(this.squash, k));
    this._squashVel = Math.max(0, this._squashVel);
  }

  private _emitBounce(wall: PinballWall, impactSpeed: number): void {
    if (impactSpeed < 60) return;
    this.bounceCount += 1;
    this._onBounce?.({ wall, impactSpeed, count: this.bounceCount });
  }
}
