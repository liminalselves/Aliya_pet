/**
 * 抚摸手势识别（移植自 Flutter PettingGestureRecognizer，逻辑等价）：
 *   - 采样 30~60Hz，固定容量环形缓冲（索引覆盖，不分配），只保留最近约 1 秒
 *   - 有效条件：单轴占比 ≥35%（兼容水平、垂直、斜向及打圈揉头）、起始距离 ≥8px、
 *     单次划动 10~480px、平滑速度 15~1000px/s、至少一次有效方向反转
 *   - 方向反转：最小反转距离 10px、后续反转防抖 60ms（首次反转不受初始确立方向耗时阻塞）、忽略 <4px 抖动
 *   - 方向反转瞬间平滑速度立即换向（绕过 EMA 滞后）
 */

/** 一次指针输入快照。 */
export interface PointerContext {
  /** 相对渲染区域归一化 X（0..1，左为 0） */
  normX: number;
  /** 相对渲染区域归一化 Y（0..1，上为 0） */
  normY: number;
  /** 视口坐标（CSS px，与 DPR 无关） */
  pxX: number;
  pxY: number;
  /** 距上一帧事件的时间（秒） */
  dtSeconds: number;
  /** 左键是否按下 */
  leftPressed: boolean;
  /** 是否为右键事件 */
  isSecondary: boolean;
  /** 指针类型（mouse/touch/pen），用于区分悬停与触摸行为 */
  pointerType?: string;
}

export interface PettingGestureResult {
  isValid: boolean;
  directionReversed: boolean;
  /** -1/0/1 */
  direction: number;
  /** 平滑水平速度（物理像素/秒） */
  smoothedVelX: number;
  /** 平滑垂直速度（物理像素/秒） */
  smoothedVelY: number;
  startDistancePx: number;
  strokeDistancePx: number;
}

interface Sample {
  timeSeconds: number;
  pxX: number;
  pxY: number;
}

interface AxisTrack {
  anchor: number;
  origin: number;
  dir: number;
  lastReversalTime: number;
  reversals: number;
  maxStroke: number;
  smoothedVel: number;
}

const createAxisTrack = (): AxisTrack => ({
  anchor: 0,
  origin: 0,
  dir: 0,
  lastReversalTime: -Infinity,
  reversals: 0,
  maxStroke: 0,
  smoothedVel: 0,
});

const resetAxisTrack = (axis: AxisTrack, pos = 0): void => {
  axis.anchor = pos;
  axis.origin = pos;
  axis.dir = 0;
  axis.lastReversalTime = -Infinity;
  axis.reversals = 0;
  axis.maxStroke = 0;
  axis.smoothedVel = 0;
};

const INVALID_RESULT: PettingGestureResult = {
  isValid: false,
  directionReversed: false,
  direction: 0,
  smoothedVelX: 0,
  smoothedVelY: 0,
  startDistancePx: 0,
  strokeDistancePx: 0,
};

export class PettingGestureRecognizer {
  private readonly _capacity: number;
  readonly sampleWindowSeconds = 1.0;
  private readonly _minStartDistancePx = 8;
  private readonly _minStrokeDistancePx = 10;
  private readonly _maxStrokeDistanceLimitPx = 480;
  private readonly _minVelocityPxPerSec = 15;
  private readonly _maxVelocityPxPerSec = 1000;
  private readonly _axisDominance = 0.35;
  private readonly _minReversalDistancePx = 10;
  private readonly _reversalDebounceSeconds = 0.06;
  private readonly _jitterPx = 4;

  private readonly _samples: Sample[];
  private _sampleHead = 0;
  private _sampleCount = 0;
  private _sampleIntervalSeconds: number;
  private _lastSampleElapsed = 0;
  private _pendingDt = 0;

  private _gestureActive = false;
  private _startCumulative = 0;
  private _lastCumulative = 0;
  private _lastPxX = 0;
  private _lastPxY = 0;
  private readonly _axisX: AxisTrack = createAxisTrack();
  private readonly _axisY: AxisTrack = createAxisTrack();
  private _gestureElapsed = 0;

  constructor(capacity = 64, sampleIntervalSeconds = 1.0 / 60.0) {
    this._capacity = capacity;
    this._samples = new Array<Sample>(capacity);
    for (let i = 0; i < capacity; i++) {
      this._samples[i] = { timeSeconds: 0, pxX: 0, pxY: 0 };
    }
    this._sampleIntervalSeconds = PettingGestureRecognizer._clampInterval(
      sampleIntervalSeconds
    );
  }

  /** 采样间隔（秒），限制为 30~60Hz。 */
  get sampleIntervalSeconds(): number {
    return this._sampleIntervalSeconds;
  }
  set sampleIntervalSeconds(v: number) {
    this._sampleIntervalSeconds = PettingGestureRecognizer._clampInterval(v);
  }

  private static _clampInterval(v: number): number {
    return Math.min(Math.max(v, 1.0 / 60.0), 1.0 / 30.0);
  }

  startGesture(origin?: PointerContext): void {
    this._gestureActive = true;
    this._sampleHead = 0;
    this._sampleCount = 0;
    this._lastSampleElapsed = 0;
    this._pendingDt = 0;
    this._startCumulative = 0;
    this._lastCumulative = 0;
    this._lastPxX = 0;
    this._lastPxY = 0;
    resetAxisTrack(this._axisX, origin?.pxX ?? 0);
    resetAxisTrack(this._axisY, origin?.pxY ?? 0);
    this._gestureElapsed = 0;
    if (origin) {
      this._lastPxX = origin.pxX;
      this._lastPxY = origin.pxY;
      Object.assign(this._samples[0], { timeSeconds: 0, pxX: origin.pxX, pxY: origin.pxY });
      this._sampleHead = 1;
      this._sampleCount = 1;
    }
  }

  endGesture(): void {
    this._gestureActive = false;
    this._sampleHead = 0;
    this._sampleCount = 0;
    this._axisX.smoothedVel = 0;
    this._axisX.dir = 0;
    this._axisY.smoothedVel = 0;
    this._axisY.dir = 0;
  }

  get isGestureActive(): boolean {
    return this._gestureActive;
  }

  get smoothedVelXPxPerSec(): number {
    return this._axisX.smoothedVel;
  }

  get smoothedVelYPxPerSec(): number {
    return this._axisY.smoothedVel;
  }

  get currentDirection(): number {
    return this._axisX.dir !== 0 ? this._axisX.dir : this._axisY.dir;
  }

  get reversalCount(): number {
    return Math.max(this._axisX.reversals, this._axisY.reversals);
  }

  get gestureElapsedSeconds(): number {
    return this._gestureElapsed;
  }

  /** 压入一个新采样并返回识别结果。不足采样间隔时累计时间与位移、不入缓冲。 */
  update(ctx: PointerContext): PettingGestureResult {
    if (!this._gestureActive) return INVALID_RESULT;

    const dt = Math.max(0.001, ctx.dtSeconds);
    this._gestureElapsed += dt;

    if (
      this._sampleCount > 0 &&
      this._gestureElapsed - this._lastSampleElapsed <
        this._sampleIntervalSeconds - 0.001
    ) {
      this._pendingDt += dt;
      // 保留上次入样坐标，累积整个采样周期的位移。
      // 未到采样间隔：保持上一次平滑速度（避免下游清零导致转向失效）
      return {
        isValid: false,
        directionReversed: false,
        direction: this.currentDirection,
        smoothedVelX: this._axisX.smoothedVel,
        smoothedVelY: this._axisY.smoothedVel,
        startDistancePx: 0,
        strokeDistancePx: 0,
      };
    }
    const sampleDt = dt + this._pendingDt;
    this._pendingDt = 0;
    this._lastSampleElapsed = this._gestureElapsed;

    if (this._sampleCount === 0) {
      resetAxisTrack(this._axisX, ctx.pxX);
      resetAxisTrack(this._axisY, ctx.pxY);
      this._lastPxX = ctx.pxX;
      this._lastPxY = ctx.pxY;
    }
    const dx = ctx.pxX - this._lastPxX;
    const dy = ctx.pxY - this._lastPxY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const reversedX = this._updateAxis(this._axisX, ctx.pxX, dx, sampleDt);
    const reversedY = this._updateAxis(this._axisY, ctx.pxY, dy, sampleDt);
    const reversed = reversedX || reversedY;

    this._lastPxX = ctx.pxX;
    this._lastPxY = ctx.pxY;
    this._lastCumulative += distance;

    const sample = this._samples[this._sampleHead];
    sample.timeSeconds = this._gestureElapsed;
    sample.pxX = ctx.pxX;
    sample.pxY = ctx.pxY;
    this._sampleHead = (this._sampleHead + 1) % this._capacity;
    if (this._sampleCount < this._capacity) this._sampleCount++;

    // 只保留最近约 1 秒（从最旧端修剪）
    while (this._sampleCount > 0) {
      const oldest = this._samples[this._oldestIndex];
      if (this._gestureElapsed - oldest.timeSeconds <= this.sampleWindowSeconds) {
        break;
      }
      this._sampleCount--;
    }

    const [valid, strokeDistance] = this._evaluateGesture();
    return {
      isValid: valid,
      directionReversed: reversed,
      direction: this.currentDirection,
      smoothedVelX: this._axisX.smoothedVel,
      smoothedVelY: this._axisY.smoothedVel,
      startDistancePx: this._lastCumulative - this._startCumulative,
      strokeDistancePx: strokeDistance,
    };
  }

  private _updateAxis(axis: AxisTrack, pos: number, delta: number, sampleDt: number): boolean {
    const vel = Math.min(Math.max(delta / sampleDt, -800), 800);
    // 方向反转时立即换向（绕过 EMA 滞后，快速往返抚摸下头部转向不迟钝）
    if (Math.abs(delta) >= this._jitterPx) {
      const newDir = delta > 0 ? 1 : -1;
      if (newDir !== axis.dir && axis.dir !== 0) {
        axis.smoothedVel = vel;
      } else {
        axis.smoothedVel = axis.smoothedVel * 0.7 + vel * 0.3;
      }
    } else {
      axis.smoothedVel = axis.smoothedVel * 0.7 + vel * 0.3;
    }

    let reversed = false;
    if (axis.dir === 0) {
      const travel = pos - axis.anchor;
      if (Math.abs(travel) >= this._jitterPx) {
        axis.dir = Math.sign(travel);
        axis.anchor = pos;
      }
    } else {
      const travel = (pos - axis.anchor) * axis.dir;
      if (travel > 0) {
        axis.anchor = pos;
      } else if (
        -travel >= this._minReversalDistancePx &&
        this._gestureElapsed - axis.lastReversalTime >= this._reversalDebounceSeconds
      ) {
        const stroke = Math.abs(axis.anchor - axis.origin);
        if (stroke >= this._minStrokeDistancePx && stroke <= this._maxStrokeDistanceLimitPx) {
          axis.maxStroke = stroke;
          axis.reversals++;
          reversed = true;
        }
        axis.origin = axis.anchor;
        axis.anchor = pos;
        axis.dir *= -1;
        axis.smoothedVel = vel;
        axis.lastReversalTime = this._gestureElapsed;
      }
    }
    return reversed;
  }

  private get _oldestIndex(): number {
    return (
      (this._sampleHead - this._sampleCount + this._capacity) % this._capacity
    );
  }

  private _sampleAt(index: number): Sample {
    return this._samples[
      (this._sampleHead - this._sampleCount + index + this._capacity) %
        this._capacity
    ];
  }

  private _isAxisValid(axis: AxisTrack, ratio: number): boolean {
    if (ratio < this._axisDominance) return false;
    const vel = Math.abs(axis.smoothedVel);
    if (vel < this._minVelocityPxPerSec || vel > this._maxVelocityPxPerSec) return false;
    if (axis.reversals <= 0) return false;
    return axis.maxStroke >= this._minStrokeDistancePx && axis.maxStroke <= this._maxStrokeDistanceLimitPx;
  }

  private _evaluateGesture(): [boolean, number] {
    if (this._sampleCount < 2) return [false, 0];

    let total = 0;
    let horizontal = 0;
    let vertical = 0;
    let prev = this._sampleAt(0);
    for (let i = 1; i < this._sampleCount; i++) {
      const cur = this._sampleAt(i);
      const ddx = cur.pxX - prev.pxX;
      const ddy = cur.pxY - prev.pxY;
      total += Math.sqrt(ddx * ddx + ddy * ddy);
      horizontal += Math.abs(ddx);
      vertical += Math.abs(ddy);
      prev = cur;
    }

    if (total < this._minStartDistancePx) return [false, 0];
    const validX = this._isAxisValid(this._axisX, total > 0 ? horizontal / total : 0);
    const validY = this._isAxisValid(this._axisY, total > 0 ? vertical / total : 0);
    if (!validX && !validY) return [false, 0];

    const strokeDistance = Math.max(
      validX ? this._axisX.maxStroke : 0,
      validY ? this._axisY.maxStroke : 0
    );
    return [true, strokeDistance];
  }
}
