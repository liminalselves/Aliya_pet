/**
 * 抚摸手势识别（移植自 Flutter PettingGestureRecognizer，逻辑等价）：
 *   - 采样 30~60Hz，固定容量环形缓冲（索引覆盖，不分配），只保留最近约 1 秒
 *   - 有效条件：水平移动占主导（>60%）、起始距离 ≥8px、单次划动 18~80px、
 *     水平速度 40~500px/s、至少一次有效方向反转
 *   - 方向反转：最小反转距离 18px、防抖 120ms、忽略 <4px 抖动
 *   - 方向反转瞬间平滑速度立即换向（绕过 EMA 滞后）
 */

/** 一次指针输入快照。 */
export interface PointerContext {
  /** 相对渲染区域归一化 X（0..1，左为 0） */
  normX: number;
  /** 相对渲染区域归一化 Y（0..1，上为 0） */
  normY: number;
  /** 视口物理像素坐标（DPI 已换算） */
  pxX: number;
  pxY: number;
  /** 距上一帧事件的时间（秒） */
  dtSeconds: number;
  /** 左键是否按下 */
  leftPressed: boolean;
  /** 是否为右键事件 */
  isSecondary: boolean;
}

export interface PettingGestureResult {
  isValid: boolean;
  directionReversed: boolean;
  /** -1/0/1 */
  direction: number;
  /** 平滑水平速度（物理像素/秒） */
  smoothedVelX: number;
  startDistancePx: number;
  strokeDistancePx: number;
}

interface Sample {
  timeSeconds: number;
  pxX: number;
  pxY: number;
}

const INVALID_RESULT: PettingGestureResult = {
  isValid: false,
  directionReversed: false,
  direction: 0,
  smoothedVelX: 0,
  startDistancePx: 0,
  strokeDistancePx: 0,
};

export class PettingGestureRecognizer {
  private readonly _capacity: number;
  readonly sampleWindowSeconds = 1.0;
  private readonly _minStartDistancePx = 8;
  private readonly _minStrokeDistancePx = 18;
  private readonly _maxStrokeDistanceLimitPx = 80;
  private readonly _minVelocityPxPerSec = 40;
  private readonly _maxVelocityPxPerSec = 500;
  private readonly _horizontalDominance = 0.6;
  private readonly _minReversalDistancePx = 18;
  private readonly _reversalDebounceSeconds = 0.12;
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
  private _directionAnchorX = 0;
  private _strokeOriginX = 0;
  private _currentDirection = 0;
  private _lastReversalTime = 0;
  private _reversalCount = 0;
  private _maxStrokeDistancePx = 0;
  private _smoothedVelX = 0;
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
    this._currentDirection = 0;
    this._lastReversalTime = 0;
    this._reversalCount = 0;
    this._maxStrokeDistancePx = 0;
    this._smoothedVelX = 0;
    this._gestureElapsed = 0;
    if (origin) {
      this._directionAnchorX = this._strokeOriginX = origin.pxX;
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
    this._smoothedVelX = 0;
    this._currentDirection = 0;
  }

  get isGestureActive(): boolean {
    return this._gestureActive;
  }

  get smoothedVelXPxPerSec(): number {
    return this._smoothedVelX;
  }

  get currentDirection(): number {
    return this._currentDirection;
  }

  get reversalCount(): number {
    return this._reversalCount;
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
        direction: this._currentDirection,
        smoothedVelX: this._smoothedVelX,
        startDistancePx: 0,
        strokeDistancePx: 0,
      };
    }
    const sampleDt = dt + this._pendingDt;
    this._pendingDt = 0;
    this._lastSampleElapsed = this._gestureElapsed;

    if (this._sampleCount === 0) {
      this._directionAnchorX = this._strokeOriginX = ctx.pxX;
      this._lastPxX = ctx.pxX;
      this._lastPxY = ctx.pxY;
    }
    const dx = ctx.pxX - this._lastPxX;
    const dy = ctx.pxY - this._lastPxY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const clampVel = (v: number) => Math.min(Math.max(v, -800), 800);
    const velX = clampVel(dx / sampleDt);
    // 方向反转时立即换向（绕过 EMA 滞后，快速往返抚摸下头部转向不迟钝）
    if (Math.abs(dx) >= this._jitterPx) {
      const newDir = dx > 0 ? 1 : -1;
      if (newDir !== this._currentDirection && this._currentDirection !== 0) {
        this._smoothedVelX = velX;
      } else {
        this._smoothedVelX = this._smoothedVelX * 0.7 + velX * 0.3;
      }
    } else {
      this._smoothedVelX = this._smoothedVelX * 0.7 + velX * 0.3;
    }

    this._lastPxX = ctx.pxX;
    this._lastPxY = ctx.pxY;
    this._lastCumulative += distance;

    // 用累计水平距离而非单个采样的 dx 判方向，低速/高回报率鼠标同样有效。
    let reversed = false;
    if (this._currentDirection === 0) {
      const travel = ctx.pxX - this._directionAnchorX;
      if (Math.abs(travel) >= this._jitterPx) {
        this._currentDirection = Math.sign(travel);
        this._lastReversalTime = this._gestureElapsed;
        this._directionAnchorX = ctx.pxX;
      }
    } else {
      const travel = (ctx.pxX - this._directionAnchorX) * this._currentDirection;
      if (travel > 0) {
        this._directionAnchorX = ctx.pxX;
      } else if (-travel >= this._minReversalDistancePx &&
                 this._gestureElapsed - this._lastReversalTime >= this._reversalDebounceSeconds) {
        const stroke = Math.abs(this._directionAnchorX - this._strokeOriginX);
        if (stroke >= this._minStrokeDistancePx && stroke <= this._maxStrokeDistanceLimitPx) {
          this._maxStrokeDistancePx = stroke;
          this._reversalCount++;
          reversed = true;
        }
        this._strokeOriginX = this._directionAnchorX;
        this._directionAnchorX = ctx.pxX;
        this._currentDirection *= -1;
        this._smoothedVelX = velX;
        this._lastReversalTime = this._gestureElapsed;
      }
    }

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
      direction: this._currentDirection,
      smoothedVelX: this._smoothedVelX,
      startDistancePx: this._lastCumulative - this._startCumulative,
      strokeDistancePx: strokeDistance,
    };
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

  private _evaluateGesture(): [boolean, number] {
    if (this._sampleCount < 2) return [false, 0];

    let total = 0;
    let horizontal = 0;
    let prev = this._sampleAt(0);
    for (let i = 1; i < this._sampleCount; i++) {
      const cur = this._sampleAt(i);
      const ddx = cur.pxX - prev.pxX;
      const ddy = cur.pxY - prev.pxY;
      total += Math.sqrt(ddx * ddx + ddy * ddy);
      horizontal += Math.abs(ddx);
      prev = cur;
    }

    if (total < this._minStartDistancePx) return [false, 0];
    const horizontalRatio = total > 0 ? horizontal / total : 0;
    if (horizontalRatio < this._horizontalDominance) return [false, 0];

    const vel = Math.abs(this._smoothedVelX);
    if (vel < this._minVelocityPxPerSec || vel > this._maxVelocityPxPerSec) {
      return [false, 0];
    }

    // 至少一次有效方向反转，且存在一段划动距离在 18~80px
    if (this._reversalCount <= 0) return [false, 0];
    const strokeDistance = this._maxStrokeDistancePx;
    if (
      strokeDistance < this._minStrokeDistancePx ||
      strokeDistance > this._maxStrokeDistanceLimitPx
    ) {
      return [false, 0];
    }
    return [true, strokeDistance];
  }
}
