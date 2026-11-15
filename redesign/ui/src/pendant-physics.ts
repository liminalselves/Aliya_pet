/**
 * 鼠标吊坠的物理：人物（系绳点 P，在头顶头发上）用一根绳子挂在指针尾部 A 上。
 *
 * - 质点 P 受重力与空气阻力；绳子只拉不推（松弛时人物自由飞出、翻转）。
 * - 空气阻力随速度增大（线性 + 带上限的二次项）：匀速移动时人物被拖在后下方、
 *   绳子拉直；小幅摆荡时阻力很小，停手后像钟摆一样来回荡几下再停。
 * - 绳子超过原长时强弹簧回拉，超过 MAX_STRETCH 硬截断。
 * - 人物朝向 angle 用角弹簧追随绳子方向：绷紧时跟得紧（身体顺着绳子倾斜），
 *   松弛时几乎自由旋转，被甩出去时会打转、翻转。
 *
 * 单位：CSS px / 秒。坐标 y 向下（屏幕坐标）。
 */

export interface PendantConfig {
  /** 绳子原长（CSS px）。 */
  ropeLength: number;
}

/** 重力加速度（CSS px/s²）：放缓下坠与回摆，减轻坠手感。 */
export const GRAVITY = 2600;
/** 空气阻力系数 = DRAG_LINEAR + DRAG_QUAD × min(|v|, DRAG_VCAP)（1/s）。 */
const DRAG_LINEAR = 1.05; // 减轻摆动阻滞，同时保留停手后的收敛。
const DRAG_QUAD = 0.0009; // 减轻高速时的黏滞感，保留甩动惯性。
const DRAG_VCAP = 1200;
/** 绳子拉伸弹簧刚度（1/s²）与径向阻尼（1/s）。 */
const ROPE_K = 2500;
const ROPE_DAMP = 24;
/** 绳子最大拉伸倍数：超出部分硬截断。 */
export const MAX_STRETCH = 1.1;
/** 人物朝向角弹簧：绷紧时的刚度（1/s²）与阻尼比；松弛时只剩 SLACK_RATIO 的刚度。 */
const ANGLE_K = 160;
const ANGLE_ZETA = 0.3;
const SLACK_RATIO = 0.01; // 松绳时弱化回正牵引，让身体更自由地延续旋转。
/** 物理子步长（秒），帧率波动时保持稳定。 */
const SUBSTEP = 1 / 240;
/** 单帧锚点跳变超过该距离（如跨屏、休眠恢复）直接复位，不甩飞人物。 */
const TELEPORT_DISTANCE = 1500;

export class PendantPhysics {
  /** 系绳点位置。 */
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** 人物朝向（弧度，0 = 头朝上竖直悬挂，正值 = 画面顺时针）。 */
  angle = 0;
  angularVelocity = 0;
  private _anchorX = 0;
  private _anchorY = 0;
  private _initialized = false;

  constructor(public config: PendantConfig) {}

  get anchorX(): number { return this._anchorX; }
  get anchorY(): number { return this._anchorY; }

  /** 把人物静止挂在锚点正下方。 */
  reset(anchorX: number, anchorY: number): void {
    this._anchorX = anchorX;
    this._anchorY = anchorY;
    this.x = anchorX;
    this.y = anchorY + this.config.ropeLength;
    this.vx = this.vy = 0;
    this.angle = this.angularVelocity = 0;
    this._initialized = true;
  }

  /** 推进一帧；锚点在本帧内从上一位置线性移动到新位置。返回 false 表示发生了复位。 */
  step(anchorX: number, anchorY: number, dt: number): boolean {
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return true;
    if (!this._initialized || Math.hypot(anchorX - this._anchorX, anchorY - this._anchorY) > TELEPORT_DISTANCE) {
      this.reset(anchorX, anchorY);
      return false;
    }
    const total = Math.min(0.05, Math.max(0, Number.isFinite(dt) ? dt : 0));
    if (total === 0) return true;
    const n = Math.max(1, Math.ceil(total / SUBSTEP));
    const h = total / n;
    const fromX = this._anchorX, fromY = this._anchorY;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this._substep(fromX + (anchorX - fromX) * t, fromY + (anchorY - fromY) * t, h);
    }
    this._anchorX = anchorX;
    this._anchorY = anchorY;
    return true;
  }

  /** 绳子两端的直线距离。 */
  get distance(): number {
    return Math.hypot(this.x - this._anchorX, this.y - this._anchorY);
  }

  /** 是否已基本静止（可降低帧率）。 */
  get settled(): boolean {
    return Math.hypot(this.vx, this.vy) < 4 && Math.abs(this.angularVelocity) < 0.05;
  }

  private _substep(ax: number, ay: number, h: number): void {
    const L = this.config.ropeLength;
    let fx = 0, fy = GRAVITY;
    const dx = this.x - ax, dy = this.y - ay;
    const d = Math.hypot(dx, dy);
    if (d > L && d > 1e-6) {
      const nx = dx / d, ny = dy / d;
      const radialV = this.vx * nx + this.vy * ny;
      const pull = ROPE_K * (d - L) + ROPE_DAMP * radialV;
      fx -= nx * pull;
      fy -= ny * pull;
    }
    // 速度越快阻力越大：匀速拖动时明显拖在后面，小幅摆荡几乎不受影响。
    const speed = Math.hypot(this.vx, this.vy);
    const drag = Math.exp(-(DRAG_LINEAR + DRAG_QUAD * Math.min(speed, DRAG_VCAP)) * h);
    // 半隐式欧拉：先速度后位置。
    this.vx = (this.vx + fx * h) * drag;
    this.vy = (this.vy + fy * h) * drag;
    this.x += this.vx * h;
    this.y += this.vy * h;

    // 硬截断：绳子不会无限拉长，去掉向外的径向速度。
    const ex = this.x - ax, ey = this.y - ay;
    const e = Math.hypot(ex, ey);
    const maxLen = L * MAX_STRETCH;
    if (e > maxLen) {
      const nx = ex / e, ny = ey / e;
      this.x = ax + nx * maxLen;
      this.y = ay + ny * maxLen;
      const radialV = this.vx * nx + this.vy * ny;
      if (radialV > 0) {
        this.vx -= radialV * nx;
        this.vy -= radialV * ny;
      }
    }

    // 朝向：系绳点（头顶）指向锚点。绳子越松刚度越低，被甩出去时人物自由翻转。
    const rx = ax - this.x, ry = ay - this.y;
    const r = Math.hypot(rx, ry);
    const taut = Math.min(1, Math.max(0, (r - 0.9 * L) / (0.1 * L)));
    const k = ANGLE_K * (SLACK_RATIO + (1 - SLACK_RATIO) * taut);
    const c = 2 * ANGLE_ZETA * Math.sqrt(k);
    const diff = r > 1 ? wrapAngle(Math.atan2(rx, -ry) - this.angle) : 0;
    this.angularVelocity += (k * diff - c * this.angularVelocity) * h;
    this.angle = wrapAngle(this.angle + this.angularVelocity * h);
  }
}

/**
 * 绳子外观：两端固定的分段 Verlet 链（只用于绘制，不反作用于人物）。
 * 两端距离不够时下垂、随惯性甩动；被拉直时绷成直线，突然绷紧会抖一下。
 */
export class RopeChain {
  readonly points: { x: number; y: number; px: number; py: number }[] = [];

  constructor(readonly segments = 16) {}

  reset(ax: number, ay: number, bx: number, by: number): void {
    this.points.length = 0;
    for (let i = 0; i <= this.segments; i++) {
      const t = i / this.segments;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      this.points.push({ x, y, px: x, py: y });
    }
  }

  step(ax: number, ay: number, bx: number, by: number, length: number, dt: number): void {
    const n = this.segments;
    if (this.points.length !== n + 1) this.reset(ax, ay, bx, by);
    const pts = this.points;
    const h = Math.min(0.05, Math.max(0, dt));
    const damping = 0.985;
    for (let i = 1; i < n; i++) {
      const p = pts[i];
      const vx = (p.x - p.px) * damping, vy = (p.y - p.py) * damping;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + GRAVITY * h * h;
    }
    const span = Math.hypot(bx - ax, by - ay);
    // 两端距离超过原长时（人物把绳子拉伸了），绳长跟着伸长，不再有可下垂的余量。
    const seg = Math.max(length, span) / n;
    for (let iter = 0; iter < 24; iter++) {
      pts[0].x = ax; pts[0].y = ay;
      pts[n].x = bx; pts[n].y = by;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        // 只约束「不超过」段长：两端距离超过绳长时整条被拉直，而不是被压缩成锯齿。
        if (d <= seg) continue;
        const diff = (d - seg) / d;
        const wa = i === 0 ? 0 : i + 1 === n ? 1 : 0.5;
        const wb = 1 - wa;
        a.x += dx * diff * wa; a.y += dy * diff * wa;
        b.x -= dx * diff * wb; b.y -= dy * diff * wb;
      }
    }
    pts[0].x = ax; pts[0].y = ay;
    pts[n].x = bx; pts[n].y = by;
    // 绷紧：每帧向两端连线收拢一半，几帧内拉直；上一帧位置不动，残留速度表现为绷紧时的抖动。
    if (span >= length * 0.98) {
      for (let i = 1; i < n; i++) {
        const t = i / n, p = pts[i];
        p.x += (ax + (bx - ax) * t - p.x) * 0.5;
        p.y += (ay + (by - ay) * t - p.y) * 0.5;
      }
    }
  }
}

export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = (a + Math.PI) % twoPi;
  if (a < 0) a += twoPi;
  return a - Math.PI;
}

/** 吊坠大小（设置值，1 = 默认）→ 人物高度（CSS px）。 */
export function pendantCharHeight(scale: number): number {
  return 150 * scale;
}
