/**
 * 拖动「被拎起」的整体姿态：人物以抓取点为支点悬挂（抓取点始终在指针下），
 * 拎起瞬间身体被往下拽长一点再弹回，随拖动方向像钟摆一样滞后摆动，
 * 停手后荡两下回正；松手时收回原样。
 *
 * 模型没有腿部绑定（见 docs/MODEL.md「腿脚能力边界」），所以悬挂感只能来自
 * 渲染矩阵：在模型→像素变换外再套一层「上提 + 拉长 + 绕抓取点旋转」。
 * 头部表情（睁眼、抬头、甩头）仍由 procedural.hold() 负责，两者叠加。
 */

/** 摆动最大角度（度）；实际还会按画布边界收小，保证人物不出画。 */
export const LIFT_MAX_DEG = 9;
/** 水平拖动速度（CSS px/s）→ 滞后角度（度）。1000px/s ≈ 6°。 */
const DEG_PER_PX_PER_SEC = 0.006;
/** 钟摆自然频率（Hz）与阻尼比：拎着时荡得久一点，放下后很快收住。 */
const SWING_HZ = 1.3;
const ZETA_HOLD = 0.28;
const ZETA_RELEASE = 0.55;
/** 悬挂拉长量（拎起时纵向拉长、横向略收）。 */
const STRETCH_Y = 0.03;
const STRETCH_X = 0.012;
/** 拉长的弹簧：拎起有一次小过冲（被拽一下），放下几乎不回弹。 */
const LIFT_HZ = 3.2;
const LIFT_ZETA_HOLD = 0.45;
const LIFT_ZETA_DROP = 0.8;
/** 指针停止多久后视为速度归零（秒）。 */
const VELOCITY_STALE = 0.06;
/** 垂直拖动速度（CSS px/s）→ 纵向弹性目标（±1）。1000px/s ≈ 0.7。 */
const BOUNCE_PER_PX_PER_SEC = 0.0007;
/** 纵向弹性弹簧参数：略高于摆动频率，呈现拎起/下落时的弹性拉伸与回弹。 */
const BOUNCE_HZ = 2.4;
const BOUNCE_ZETA_HOLD = 0.28;
const BOUNCE_ZETA_RELEASE = 0.55;
/** 纵向弹性造成的渲染比例缩放（正值 = 纵长横收；负值 = 纵扁横舒，保持近似面积感）。 */
const BOUNCE_STRETCH_Y = 0.065;
const BOUNCE_STRETCH_X = 0.032;

export class LiftPose {
  /** 当前摆角（度，画面坐标：正值 = 下半身甩向左，即向右拖时滞后）。 */
  angle = 0;
  private _vel = 0;
  /** 纵向弹性偏移（[-1, 1]：正 = 向上拖惯性拉长，负 = 向下拖惯性微缩回弹）。 */
  bounce = 0;
  private _bounceVel = 0;
  /** 悬挂程度，约 0..1（拎起时有小过冲）。 */
  lift = 0;
  private _liftVel = 0;
  private _holding = false;
  private _rawVx = 0;
  private _vx = 0;
  private _sinceVx = 0;
  private _rawVy = 0;
  private _vy = 0;
  private _sinceVy = 0;

  /** 开始 / 结束拎起。 */
  setHolding(holding: boolean): void {
    this._holding = holding;
    if (!holding) {
      this._rawVx = 0;
      this._rawVy = 0;
    }
  }

  get holding(): boolean {
    return this._holding;
  }

  /** 拖动中的画面速度（CSS px/s，右/下为正）。 */
  setVelocity(vxCssPerSec: number, vyCssPerSec = 0): void {
    if (!this._holding) return;
    if (Number.isFinite(vxCssPerSec)) {
      this._rawVx = vxCssPerSec;
      this._sinceVx = 0;
    }
    if (Number.isFinite(vyCssPerSec)) {
      this._rawVy = vyCssPerSec;
      this._sinceVy = 0;
    }
  }

  /** 是否还有可见偏移（无偏移时渲染走原矩阵）。 */
  get active(): boolean {
    return Math.abs(this.lift) > 0.001
      || Math.abs(this.angle) > 0.01
      || Math.abs(this._vel) > 0.05
      || Math.abs(this.bounce) > 0.005
      || Math.abs(this._bounceVel) > 0.05;
  }

  /** @param reduce 少动态效果：只保留上提，不摆、不拉长。 */
  update(dt: number, reduce = false): void {
    const total = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    if (total === 0) return;
    // 低帧率（省电 15fps）下拆成 ≤1/60s 的子步：弹簧在大步长欧拉积分下会过冲抖动。
    const n = Math.max(1, Math.ceil(total / (1 / 60)));
    for (let i = 0; i < n; i++) this._step(total / n, reduce, total);
  }

  private _step(step: number, reduce: boolean, frame: number): void {
    this._sinceVx += step;
    this._sinceVy += step;
    // 速度过期阈值不得小于帧间隔，否则低帧率下相邻帧之间速度被误清零。
    const staleLimit = Math.max(VELOCITY_STALE, frame * 1.5);
    if (this._sinceVx > staleLimit) this._rawVx = 0;
    if (this._sinceVy > staleLimit) this._rawVy = 0;
    const velAlpha = 1 - Math.exp(-step / 0.08);
    this._vx += (this._rawVx - this._vx) * velAlpha;
    this._vy += (this._rawVy - this._vy) * velAlpha;

    const lw = 2 * Math.PI * LIFT_HZ;
    const lz = this._holding ? LIFT_ZETA_HOLD : LIFT_ZETA_DROP;
    this._liftVel += (lw * lw * ((this._holding ? 1 : 0) - this.lift) - 2 * lz * lw * this._liftVel) * step;
    this.lift += this._liftVel * step;
    if (!this._holding && Math.abs(this.lift) < 0.001 && Math.abs(this._liftVel) < 0.01) this.lift = this._liftVel = 0;

    if (reduce) {
      // 少动态效果：不摆、不拉长，人物保持原样跟手。
      this.angle = this._vel = this.lift = this._liftVel = this.bounce = this._bounceVel = 0;
      return;
    }
    const target = this._holding
      ? Math.max(-LIFT_MAX_DEG, Math.min(LIFT_MAX_DEG, this._vx * DEG_PER_PX_PER_SEC))
      : 0;
    const omega = 2 * Math.PI * SWING_HZ;
    const zeta = this._holding ? ZETA_HOLD : ZETA_RELEASE;
    // 半隐式欧拉：先更新速度再更新角度，帧率波动下也稳定。
    this._vel += (omega * omega * (target - this.angle) - 2 * zeta * omega * this._vel) * step;
    this.angle += this._vel * step;
    // 弹簧过冲也不超过上限：撞到边界时吸收速度，不反弹。
    if (Math.abs(this.angle) > LIFT_MAX_DEG) {
      this.angle = Math.sign(this.angle) * LIFT_MAX_DEG;
      if (Math.sign(this._vel) === Math.sign(this.angle)) this._vel = 0;
    }
    if (!this._holding && Math.abs(this.angle) < 0.01 && Math.abs(this._vel) < 0.05) {
      this.angle = this._vel = 0;
    }

    const targetBounce = this._holding
      ? Math.max(-1, Math.min(1, -this._vy * BOUNCE_PER_PX_PER_SEC))
      : 0;
    const bw = 2 * Math.PI * BOUNCE_HZ;
    const bz = this._holding ? BOUNCE_ZETA_HOLD : BOUNCE_ZETA_RELEASE;
    this._bounceVel += (bw * bw * (targetBounce - this.bounce) - 2 * bz * bw * this._bounceVel) * step;
    this.bounce += this._bounceVel * step;
    if (Math.abs(this.bounce) > 1) {
      this.bounce = Math.sign(this.bounce);
      if (Math.sign(this._bounceVel) === Math.sign(this.bounce)) this._bounceVel = 0;
    }
    if (!this._holding && Math.abs(this.bounce) < 0.005 && Math.abs(this._bounceVel) < 0.05) {
      this.bounce = this._bounceVel = 0;
    }
  }
}

export interface LiftFrame {
  /** 基础变换：模型单位 → 缓冲像素（x = scale·mx + originX，y = −scale·my + originY）。 */
  scale: number;
  originX: number;
  originY: number;
  /** 支点（缓冲像素，未镜像坐标）。 */
  pivotX: number;
  pivotY: number;
  /** 缓冲坐标系里的摆角（度）；镜像时调用方已取反。 */
  angleDeg: number;
  lift: number;
  /** 纵向弹性偏移（[-1, 1]，向上拖拉长为正、向下拖微压为负）。 */
  bounce?: number;
  /** 静态包围盒（模型单位）与画布尺寸（缓冲像素），用于防出画。 */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  width: number;
  height: number;
}

/**
 * 计算悬挂姿态的模型矩阵（CubismMatrix44 行向量布局，16 元）。
 * 摆角与纵向拉伸都会按画布边界收小：包围盒四角旋转/缩放后仍在画布内（留 2px）。
 */
export function liftMatrix(f: LiftFrame): Float32Array {
  const fits = (deg: number, bounce: number) => {
    const m = compose(f, deg, bounce);
    const { minX, maxX, minY, maxY } = f.bounds;
    for (const [x, y] of [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]]) {
      const px = m[0] * x + m[4] * y + m[12];
      const py = m[1] * x + m[5] * y + m[13];
      if (px < 2 || px > f.width - 2 || py < 2 || py > f.height - 2) return false;
    }
    return true;
  };
  let bounce = f.bounce ?? 0;
  if (bounce !== 0 && !fits(0, bounce)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (fits(0, bounce * mid)) lo = mid; else hi = mid;
    }
    bounce *= lo;
  }
  let deg = f.angleDeg;
  if (deg !== 0 && !fits(deg, bounce)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (fits(deg * mid, bounce)) lo = mid; else hi = mid;
    }
    deg *= lo;
  }
  return compose(f, deg, bounce);
}

function compose(f: LiftFrame, deg: number, bounce: number): Float32Array {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const sx = 1 - STRETCH_X * f.lift - BOUNCE_STRETCH_X * bounce;
  const sy = 1 + STRETCH_Y * f.lift + BOUNCE_STRETCH_Y * bounce;
  const a = f.scale * sx;
  const b = -f.scale * sy;
  // 模型原点依次经过：绕支点拉长/回弹 → 绕支点旋转；支点本身不动（始终在指针下）。
  const dx = sx * (f.originX - f.pivotX);
  const dy = sy * (f.originY - f.pivotY);
  const m = new Float32Array(16);
  m[0] = cos * a; m[1] = sin * a;
  m[4] = -sin * b; m[5] = cos * b;
  m[10] = 1; m[15] = 1;
  m[12] = f.pivotX + cos * dx - sin * dy;
  m[13] = f.pivotY + sin * dx + cos * dy;
  return m;
}
