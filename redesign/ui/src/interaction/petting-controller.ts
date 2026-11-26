/**
 * 抚摸控制器（移植自 Flutter HeadPettingService + PettingReactionController +
 * InteractionStateService，三者合并为一个每帧驱动的控制器）：
 *
 * 状态机：Inactive → Pressed → Petting → Finishing → Inactive
 *   - 右键（触屏为单指）在头部抚摸区按下进入；松开恢复，Esc 立即取消
 *   - 识别到有效抚摸手势后才闭眼；左键单击/触摸轻点头部走普通点击互动
 *
 * 反应（全部经 InteractionTarget 通道写入）：
 *   - 头部跟随：非线性响应 sign·|v/vref|^0.65，一阶滞后（运动 tau 0.10s / 回正 0.16s）
 *   - 静止姿态：短暂停手（<0.45s）保留最后方向 25~35% + 轻微低头
 *   - 抚摸闭眼 180~320ms、结束睁眼 280~500ms，完成后恢复自动眨眼
 *   - 边缘贴手：指针在头部左右/上下边缘时头与上半身同向朝该侧偏倾，与速度跟随叠加（AngleX ≤22°、AngleZ ≤12°、BodyZ ≤3°）
 *
 * 反应组触发（reactions.json 的 petting.* 触发键）：start 40%（当日次数多时改 repeat）/
 *   fast(>250px/s 持续 0.8s) / long(10s) / soft·active(2~4s 起，最多 2 条间隔 4s，60%) /
 *   end(>1s 主动结束 30%)
 */

import { HitAreas } from './hit-areas';
import {
  PettingGestureRecognizer,
  PointerContext,
} from './petting-recognizer';
import {
  InteractionTarget,
  type ArmInteractionValues,
  type FaceMicroInteractionValues,
  type InteractionPose,
} from './target';

export type PettingState =
  | 'inactive'
  | 'pressed'
  | 'petting'
  | 'finishing';

export type PettingEndReason =
  | 'mouseReleased'
  | 'escapePressed'
  | 'modeChanged'
  | 'windowClosing'
  | 'modelReload'
  // 触摸手势被系统/壳层截断（pointercancel / 原生拖动接管）：非用户主动松手
  | 'gestureCanceled';

/** 抚摸台词宿主（由上层实现）。 */
export interface PettingDialogueHost {
  /** 当前是否正在播放台词（抚摸反应不打断它）。 */
  isDialogueActive(): boolean;
}

/** 抚摸触觉震动脉冲描述（由 Android 等支持震动的端消费）。 */
export interface PettingHapticPulse {
  kind: 'start' | 'stroke' | 'reverse';
  durationMs: number;
  amplitude: number;
}

/** 播放触发键下的反应组；返回说出的台词 id（没说话为 null）。 */
export type PettingReact = (trigger: string, excludeIds: Set<string>) => string | null;

/** 当日互动统计持久化接口（由上层接入 localStorage 等跨刷新存储）。 */
export interface DailyInteractionPersistence {
  load(): { day: string; headPettingCountToday: number; headPettingDurationTodayMs: number; longestPettingDurationMs: number };
  save(stats: { day: string; headPettingCountToday: number; headPettingDurationTodayMs: number; longestPettingDurationMs: number }): void;
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 当日互动状态（跨天自动清零，可选持久化）。 */
class DailyInteractionState {
  headPettingCountToday = 0;
  headPettingDurationTodayMs = 0;
  longestPettingDurationMs = 0;
  readonly lastPettingDialogueIds: string[] = [];
  private _lastDay = DailyInteractionState._today();
  private readonly _persistence?: DailyInteractionPersistence;

  constructor(persistence?: DailyInteractionPersistence) {
    this._persistence = persistence;
    this._restoreFromPersistence();
  }

  private static _today(): string {
    const n = new Date();
    return `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}`;
  }

  private _restoreFromPersistence(): void {
    if (!this._persistence) return;
    const saved = this._persistence.load();
    if (saved.day !== this._lastDay) return;
    this.headPettingCountToday = saved.headPettingCountToday;
    this.headPettingDurationTodayMs = saved.headPettingDurationTodayMs;
    this.longestPettingDurationMs = saved.longestPettingDurationMs;
  }

  ensureDayFresh(): void {
    const today = DailyInteractionState._today();
    if (today !== this._lastDay) {
      this._lastDay = today;
      this.headPettingCountToday = 0;
      this.headPettingDurationTodayMs = 0;
      this.longestPettingDurationMs = 0;
      this.lastPettingDialogueIds.length = 0;
      return;
    }
    if (this._persistence) {
      const saved = this._persistence.load();
      if (saved.day === today && saved.headPettingCountToday > this.headPettingCountToday) {
        this.headPettingCountToday = saved.headPettingCountToday;
        this.headPettingDurationTodayMs = saved.headPettingDurationTodayMs;
        this.longestPettingDurationMs = saved.longestPettingDurationMs;
      }
    }
  }

  beginPetting(): void {
    this.ensureDayFresh();
  }

  endPetting(durationMs: number): void {
    this.ensureDayFresh();
    this.headPettingCountToday++;
    this.headPettingDurationTodayMs += Math.max(0, durationMs);
    if (durationMs > this.longestPettingDurationMs) {
      this.longestPettingDurationMs = durationMs;
    }
    this._persistence?.save({
      day: this._lastDay,
      headPettingCountToday: this.headPettingCountToday,
      headPettingDurationTodayMs: this.headPettingDurationTodayMs,
      longestPettingDurationMs: this.longestPettingDurationMs,
    });
  }

  recordDialogueId(id: string): void {
    if (!id) return;
    const i = this.lastPettingDialogueIds.indexOf(id);
    if (i >= 0) this.lastPettingDialogueIds.splice(i, 1);
    this.lastPettingDialogueIds.unshift(id);
    if (this.lastPettingDialogueIds.length > 4) {
      this.lastPettingDialogueIds.length = 4;
    }
  }
}

export class PettingController {
  readonly recognizer = new PettingGestureRecognizer();
  readonly dailyState: DailyInteractionState;

  state: PettingState = 'inactive';

  private readonly _hitAreas: HitAreas;
  private readonly _getTarget: () => InteractionTarget | null;
  private readonly _react: PettingReact;
  private readonly _host: PettingDialogueHost;

  // 会话计时
  private _sessionStartMs = 0;
  private _sessionElapsedMs = 0;
  private _lastSoftOrActiveMs = 0;
  private _softActiveCount = 0;
  private _fastTriggered = false;
  private _fastElapsedMs = 0;
  private _recognized = false;
  private _longTriggered = false;
  private _endDialogueTriggered = false;
  private _finishingStartMs = 0;
  private _sessionEnding = false;

  // ---- 反应：参数范围（模型就绪后探测）----
  private _configured = false;
  private _available = false;
  private _hasEyes = false;
  private _angleXMin = -30;
  private _angleXMax = 30;
  private _angleYMin = -30;
  private _angleYMax = 30;
  private _angleZMin = -30;
  private _angleZMax = 30;
  private _bodyXMin = -30;
  private _bodyXMax = 30;
  private _bodyYMin = -10;
  private _bodyYMax = 10;
  private _eyeLMin = 0;
  private _eyeLMax = 1;
  private _eyeRMin = 0;
  private _eyeRMax = 1;

  // 当前平滑值 / 目标值
  private _curAngleX = 0;
  private _curAngleY = 0;
  private _curAngleZ = 0;
  private _curBodyX = 0;
  private _curBodyY = 0;
  private _curBodyZ = 0;
  private _targetAngleX = 0;
  private _targetAngleY = 0;
  private _targetAngleZ = 0;
  private _targetBodyX = 0;
  private _targetBodyY = 0;
  private _curCheek = 0;
  private _curEarL = 0;
  private _curEarR = 0;
  private _curArmL01 = 0;
  private _curArmL02 = 0;
  private _curArmR01 = 0;
  private _curArmR02 = 0;
  private _curEyeSmile = 0;
  private _curMouthForm = 0;
  private _curBrowForm = 0;
  private _curBrowY = 0;
  private _lastHairImpulseMs = 0;

  // 眼睛（抚摸期间保持闭合，释放直接退出覆盖通道由 EyeOverrideChannel 按当前表情平滑睁眼）
  private _eyeOverrideActive = false;

  // ---- 头部跟随参数（度）----
  private static readonly _maxAngleX = 16.0;
  private static readonly _maxAngleZ = 9.0;
  private static readonly _basePetAngleY = -2.0;
  private static readonly _maxAngleYSwing = 19.0;
  private static readonly _pettingDirectionSign = 1.0;
  private static readonly _velocityReference = 300.0;
  private static readonly _minAngleX = 4.5;
  private static readonly _minAngleZ = 2.8;
  private static readonly _minAngleYDelta = 5.0;
  private static readonly _idleHoldAngleX = 4.5;
  private static readonly _idleHoldAngleZ = 2.6;
  private static readonly _idleHoldAngleY = 2.5;
  private static readonly _idleHoldAngleYDelta = 5.0;

  // 边缘贴手：指针在头部边缘时头朝该侧偏（-1..1，模型空间；X 右为正，Y 上为正）
  private _leanX = 0;
  private _leanY = 0;
  private _leanEngaged = false;
  private _pressPxX = 0;
  private _pressPxY = 0;
  private static readonly _leanAngleX = 16.0;
  private static readonly _leanAngleZ = 10.5;
  private static readonly _leanAngleY = 8.0;
  private static readonly _leanBodyX = 4.5;
  private static readonly _leanBodyZ = 2.0;
  private static readonly _leanFollowDamp = 0.55;
  private static readonly _maxTotalAngleX = 22.0;
  private static readonly _maxTotalAngleZ = 12.0;
  private static readonly _maxTotalAngleY = 24.0;
  private static readonly _maxTotalBodyX = 7.5;
  private static readonly _maxTotalBodyZ = 2.4;

  private _pettingActive = false;
  private _lastVel = 0;
  private _lastVelY = 0;
  private _lastDir = 0;
  private _lastDirY = 0;
  private _lastInputMs = 0;
  private _lastRawPxX = 0;
  private _lastRawPxY = 0;

  private static readonly _headTauSeconds = 0.1;
  private static readonly _returnTauSeconds = 0.16;

  private _lastLookAtReduction = false;

  // 触觉震动节律跟踪
  private _hapticLastMs = 0;
  private _hapticLastX = 0;
  private _hapticLastY = 0;
  private _hapticAccumPx = 0;

  /** 抚摸会话结束回调（上层用于收尾光标等）。 */
  onSessionEnded: ((reason: PettingEndReason) => void) | null = null;
  /** 抚摸阶段事件通知（用于 PetAI 观察）。 */
  onStageEvent: ((stage: 'start' | 'soft' | 'active' | 'fast' | 'long' | 'repeat' | 'end') => void) | null = null;
  /** 抚摸触觉震动回调（用于移动端短促反馈）。 */
  onHaptic: ((pulse: PettingHapticPulse) => void) | null = null;

  constructor(deps: {
    hitAreas: HitAreas;
    getTarget: () => InteractionTarget | null;
    host: PettingDialogueHost;
    react: PettingReact;
    persistence?: DailyInteractionPersistence;
    onHaptic?: (pulse: PettingHapticPulse) => void;
  }) {
    this._hitAreas = deps.hitAreas;
    this._getTarget = deps.getTarget;
    this._host = deps.host;
    this._react = deps.react;
    this.onHaptic = deps.onHaptic ?? null;
    this.dailyState = new DailyInteractionState(deps.persistence);
  }

  get isPettingModeActive(): boolean {
    return this.state !== 'inactive';
  }

  /** 当前是否有激活的抚摸会话（Pressed/Petting/Finishing）。 */
  get isPettingSessionActive(): boolean {
    return (
      this.state === 'pressed' ||
      this.state === 'petting' ||
      this.state === 'finishing'
    );
  }

  get smoothedVelocityXPxPerSec(): number {
    return this.recognizer.smoothedVelXPxPerSec;
  }

  setInputRateHz(hz: number): void {
    const clamped = Math.min(Math.max(hz, 30), 60);
    this.recognizer.sampleIntervalSeconds = 1.0 / clamped;
  }

  // ---------- 指针输入 ----------

  /** 指针移动。返回 true 表示互动已接管（上层不再移动窗口）。 */
  onPointerMove(ctx: PointerContext): boolean {
    if (!this.isPettingSessionActive) return false;

    if (this.state === 'pressed' || this.state === 'petting') {
      const result = this.recognizer.update(ctx);
      if (!this._leanEngaged && Math.hypot(ctx.pxX - this._pressPxX, ctx.pxY - this._pressPxY) >= 8) {
        this._leanEngaged = true; // 按住后移动 ≥8px 才算抚摸，避免右键单击抽动
      }
      if (this._leanEngaged) this._updateLean(ctx);
      const now = performance.now();
      const moved = Math.hypot(ctx.pxX - this._lastRawPxX, ctx.pxY - this._lastRawPxY) >= 1.5;
      if (moved) {
        this._lastRawPxX = ctx.pxX;
        this._lastRawPxY = ctx.pxY;
        this._lastInputMs = now;
      }
      if (result.directionReversed && this.state === 'petting') {
        this._lastInputMs = now;
      }
      if (this.state === 'petting' || result.isValid) {
        if (moved || result.isValid || result.directionReversed) {
          this.setVelocity(result.smoothedVelX, true, moved || result.directionReversed, result.smoothedVelY);
        }
      }
      const speed = Math.hypot(result.smoothedVelX, result.smoothedVelY);
      if (result.isValid && this.state === 'pressed') {
        this._recognized = true;
        this._sessionStartMs = now;
        this._lastInputMs = now;
        this._beginEyeClose(); // 识别到抚摸手势（按住并滑动）后闭眼
        this._setState('petting');
        this._onPettingStarted();
        this._hapticLastX = ctx.pxX;
        this._hapticLastY = ctx.pxY;
        this._hapticAccumPx = 0;
        this._hapticLastMs = now;
        this._emitHaptic('start', speed);
      } else if (this.state === 'petting') {
        this._updatePettingHaptic(ctx, result.directionReversed, speed, now);
        if (result.directionReversed || (moved && now - this._lastHairImpulseMs >= 180)) {
          this._lastHairImpulseMs = now;
          const target = this._getTarget();
          if (target?.triggerPartImpulse) {
            if (Math.abs(result.smoothedVelY) > Math.abs(result.smoothedVelX)) {
              target.triggerPartImpulse('hair_bounce', result.smoothedVelY > 0 ? -0.35 : 0.3);
            } else {
              const vel = this._hitAreas.mirrored ? -result.smoothedVelX : result.smoothedVelX;
              const dir = vel >= 0 ? 1 : -1;
              target.triggerPartImpulse('hair_bounce', -0.25);
              target.triggerPartImpulse('bangs', dir * 0.18);
            }
          }
        }
      }
      return true;
    }
    return false;
  }

  /**
   * 指针按下。返回 true 表示互动已接管（上层不开始拖动/单击）。
   * 抚摸仅允许右键触发（Windows 约定）；左键留给拖动桌宠/普通点击。
   */
  onPointerDown(ctx: PointerContext): boolean {
    const isDesktopSecondary = ctx.pointerType === 'mouse' || ctx.pointerType === 'pen';
    const inZone =
      this._hitAreas.isInHeadPetZone(ctx.normX, ctx.normY) ||
      (isDesktopSecondary && !ctx.leftPressed && (this._hitAreas.isInHeadRegion?.(ctx.normX, ctx.normY) ?? false));
    if (!ctx.isSecondary || !inZone) return false;
    if (this.state !== 'inactive' && this.state !== 'finishing') return false;

    this.resetAll();
    this._sessionEnding = false;
    this._sessionStartMs = performance.now();
    this._sessionElapsedMs = 0;
    this._softActiveCount = 0;
    this._lastSoftOrActiveMs = 0;
    this._fastTriggered = false;
    this._fastElapsedMs = 0;
    this._recognized = false;
    this._longTriggered = false;
    this._endDialogueTriggered = false;
    this._lastInputMs = this._sessionStartMs;
    this._lastHairImpulseMs = 0;
    this._lastRawPxX = ctx.pxX;
    this._lastRawPxY = ctx.pxY;
    this._pressPxX = ctx.pxX;
    this._pressPxY = ctx.pxY;
    this.recognizer.startGesture(ctx);
    this.dailyState.beginPetting();
    if (isDesktopSecondary && !ctx.leftPressed) {
      this._leanEngaged = true;
      this._updateLean(ctx);
    }
    this._setState('pressed');
    return true;
  }

  /** 指针松开。返回 true 表示互动已接管。 */
  onPointerUp(ctx: PointerContext): boolean {
    if (!ctx.isSecondary) return false;
    if (this.state === 'pressed' || this.state === 'petting') {
      this.endPettingSession('mouseReleased');
      return true;
    }
    return false;
  }

  onEsc(): void {
    if (this.isPettingModeActive) this.exitPettingMode('escapePressed');
  }

  // ---------- 模式切换 ----------

  exitPettingMode(reason: PettingEndReason): void {
    if (this.state === 'inactive') return;
    if (this.isPettingSessionActive) {
      this.endPettingSession(reason);
    }
    this.recognizer.endGesture();
    // 用户取消仍走睁眼和回中；只有模型销毁/不可用才立即清理。
    if (reason === 'modelReload' || reason === 'windowClosing' || !this._available) {
      this.resetAll();
      this._sessionEnding = false;
      this._setState('inactive');
    }
  }

  /** 统一结束方法：未识别的按压直接复位；已识别抚摸 → Finishing → 释放眼覆盖由通道按表情睁眼。 */
  endPettingSession(reason: PettingEndReason): void {
    if (!this.isPettingSessionActive || this._sessionEnding) return;
    this._sessionEnding = true;

    this.recognizer.endGesture();
    if (!this._recognized) {
      // 未识别成有效抚摸的 pressed 直接退出，不误触发睁眼与 600ms finishing 忙碌期。
      this.resetAll();
      this._sessionEnding = false;
      this._setState('inactive');
      this.onSessionEnded?.(reason);
      return;
    }

    this._setState('finishing');
    this.setVelocity(0, false);
    this._eyeOverrideActive = false;

    const durationMs = performance.now() - this._sessionStartMs;
    this.dailyState.endPetting(durationMs);

    // 结束台词：仅用户主动结束且时长 > 1s 时小概率触发
    if (
      durationMs > 1000 &&
      !this._endDialogueTriggered &&
      reason === 'mouseReleased' &&
      Math.random() < 0.3
    ) {
      this._endDialogueTriggered = true;
      this._playTag('petting.end');
      this.onStageEvent?.('end');
    }

    this._finishingStartMs = performance.now();
    this.onSessionEnded?.(reason);
  }

  /** 只转交恢复动画的所有权，不复位通道，也不重复结算会话或触发台词。 */
  releaseFinishing(): InteractionPose | null {
    if (this.state !== 'finishing') return null;
    const arms: ArmInteractionValues = {
      armL01: this._curArmL01,
      armL02: this._curArmL02,
      armR01: this._curArmR01,
      armR02: this._curArmR02,
    };
    const faceMicro: FaceMicroInteractionValues = {
      eyeSmile: this._curEyeSmile,
      mouthForm: this._curMouthForm,
      browForm: this._curBrowForm,
      browY: this._curBrowY,
    };
    const pose: InteractionPose = {
      headX: this._curAngleX, headY: this._curAngleY, headZ: this._curAngleZ,
      bodyX: this._curBodyX, bodyY: this._curBodyY, bodyZ: this._curBodyZ,
      eyeEnabled: false,
      eyeLeft: 0,
      eyeRight: 0,
      earL: this._curEarL,
      earR: this._curEarR,
      cheek: this._curCheek,
      arms,
      faceMicro,
    };
    this.recognizer.endGesture();
    this._applyLookAtReduction(false);
    this._sessionEnding = false;
    this._setState('inactive');
    return pose;
  }

  // ---------- 反应：目标计算 ----------

  /** 按平滑水平/垂直速度设置头部目标（petting=false 时全部回正；镜像时翻转水平方向）。 */
  setVelocity(velXPxPerSec: number, petting: boolean, refreshInput = true, velYPxPerSec = 0): void {
    if (!petting) {
      this._pettingActive = false;
      this._lastVel = 0;
      this._lastVelY = 0;
      this._lastDir = 0;
      this._lastDirY = 0;
      this._targetAngleX = 0;
      this._targetAngleY = 0;
      this._targetAngleZ = 0;
      this._targetBodyX = 0;
      this._targetBodyY = 0;
      this._leanX = 0;
      this._leanY = 0;
      this._leanEngaged = false;
      this._applyLookAtReduction(false);
      return;
    }
    if (refreshInput && Math.hypot(velXPxPerSec, velYPxPerSec) > 20) {
      this._lastInputMs = performance.now();
    }
    const modelVel = this._hitAreas.mirrored ? -velXPxPerSec : velXPxPerSec;
    this._pettingActive = true;
    this._lastVel = Math.min(Math.max(modelVel, -800), 800);
    this._lastVelY = Math.min(Math.max(velYPxPerSec, -800), 800);
    if (Math.abs(this._lastVel) > 20) {
      this._lastDir = Math.sign(this._lastVel);
    }
    if (Math.abs(this._lastVelY) > 20) {
      this._lastDirY = Math.sign(this._lastVelY);
    }
    this._applyLookAtReduction(true);
    this._computePettingTargets(this._lastVel, this._lastVelY);
  }

  /** 非线性响应：低速也有明显反馈，高速仍受上限限制。 */
  private _computePettingTargets(vel: number, velY = 0): void {
    const normalized = Math.min(
      Math.max(vel / PettingController._velocityReference, -1),
      1
    );
    const response = Math.sign(normalized) * Math.pow(Math.abs(normalized), 0.65);
    let angleX = response * PettingController._maxAngleX * PettingController._pettingDirectionSign;
    let angleZ = -response * PettingController._maxAngleZ * PettingController._pettingDirectionSign;

    // 有效水平抚摸最低反馈
    if (Math.abs(normalized) > 0.02) {
      const xSign = angleX >= 0 ? 1 : -1;
      const zSign = angleZ >= 0 ? 1 : -1;
      if (Math.abs(angleX) < PettingController._minAngleX) {
        angleX = PettingController._minAngleX * xSign;
      }
      if (Math.abs(angleZ) < PettingController._minAngleZ) {
        angleZ = PettingController._minAngleZ * zSign;
      }
    }

    const normalizedY = Math.min(
      Math.max(velY / PettingController._velocityReference, -1),
      1
    );
    const responseY = Math.sign(normalizedY) * Math.pow(Math.abs(normalizedY), 0.65);
    // 屏幕 Y 向下为正，Live2D AngleY / BodyAngleY 向上为正
    let deltaY = -responseY * PettingController._maxAngleYSwing;
    if (Math.abs(normalizedY) > 0.02 && Math.abs(deltaY) < PettingController._minAngleYDelta) {
      deltaY = Math.sign(deltaY) * PettingController._minAngleYDelta;
    }

    this._targetAngleX = angleX;
    this._targetAngleZ = angleZ;
    this._targetAngleY = PettingController._basePetAngleY + deltaY;
    this._targetBodyX = Math.max(-4.8, Math.min(4.8, angleX * 0.28));
    const bodyVelY = Math.abs(velY) > 25 ? Math.sign(velY) * (Math.abs(velY) - 25) : 0;
    const bodyNormY = Math.min(Math.max(bodyVelY / (PettingController._velocityReference - 25), -1), 1);
    const bodyRespY = Math.sign(bodyNormY) * Math.pow(Math.abs(bodyNormY), 0.65);
    this._targetBodyY = Math.max(-4.8, Math.min(3.8, -0.7 - bodyRespY * 4.8));
  }

  private _beginEyeClose(): void {
    this._eyeOverrideActive = true;
  }

  /** 按指针在头部的位置计算贴手偏向：中心小死区，边缘满偏；远离头部（r>1.8 起）渐隐。 */
  private _updateLean(ctx: PointerContext): void {
    // 部分测试桩/调用方的 hitAreas 未实现该方法
    const off = this._hitAreas.headPetOffset?.(ctx.normX, ctx.normY);
    if (!off) { this._leanX = 0; this._leanY = 0; return; }
    const presence = 1 - smoothstep(1.8, 2.6, Math.hypot(off.x, off.y));
    this._leanX = Math.sign(off.x) * smoothstep(0.2, 0.85, Math.abs(off.x)) * presence;
    // 屏幕 Y 向下为正，AngleY 向上为正
    this._leanY = -Math.sign(off.y) * smoothstep(0.25, 0.9, Math.abs(off.y)) * presence;
    if (!this._pettingActive) {
      this._applyLookAtReduction(Math.abs(this._leanX) > 0.01 || Math.abs(this._leanY) > 0.01);
    }
  }

  /** 立即复位全部互动参数（退出抚摸/异常恢复）。 */
  resetAll(): void {
    this._curAngleX = this._curAngleY = this._curAngleZ = this._curBodyX = 0;
    this._curBodyY = this._curBodyZ = 0;
    this._targetAngleX = this._targetAngleY = this._targetAngleZ = this._targetBodyX = this._targetBodyY = 0;
    this._leanX = 0;
    this._leanY = 0;
    this._leanEngaged = false;
    this._curCheek = 0;
    this._curEarL = this._curEarR = 0;
    this._curArmL01 = this._curArmL02 = this._curArmR01 = this._curArmR02 = 0;
    this._curEyeSmile = this._curMouthForm = this._curBrowForm = this._curBrowY = 0;
    this._lastHairImpulseMs = 0;
    this._eyeOverrideActive = false;
    this._pettingActive = false;
    this._lastVel = 0;
    this._lastVelY = 0;
    this._lastDir = 0;
    this._lastDirY = 0;
    this._hapticLastMs = 0;
    this._hapticLastX = 0;
    this._hapticLastY = 0;
    this._hapticAccumPx = 0;
    this._applyLookAtReduction(false, true);
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
        // 写入失败不影响互动流程
      }
    }
  }

  /** 抚摸期间降低 LookAt 对头部角度权重。 */
  private _applyLookAtReduction(enabled: boolean, force = false): void {
    if (!force && this._lastLookAtReduction === enabled) return;
    this._lastLookAtReduction = enabled;
    try {
      this._getTarget()?.setPettingLookAtReduction(enabled);
    } catch {
      // 忽略
    }
  }

  // ---------- 每帧驱动（由渲染循环调用，替代 Flutter 的 33ms 双定时器） ----------

  tick(dtMs: number): void {
    // 与 Flutter 一致：反应定时器仅在抚摸模式期间运行，
    // 避免与程序化反应服务争夺同一参数通道
    if (!this.isPettingModeActive) return;
    const target = this._getTarget();
    if (!target) return;
    this._ensureConfigured(target);
    if (!this._available) {
      this.exitPettingMode('gestureCanceled');
      return;
    }

    const dt = Math.min(Math.max(dtMs / 1000, 0.001), 0.1);

    // 目标选择：运动中 → 运动目标；短暂停止 → 放松静止姿态；长时间停止 → 回中
    const idleSec = (performance.now() - this._lastInputMs) / 1000;
    if (this._pettingActive) {
      if (idleSec < 0.08) {
        this._computePettingTargets(this._lastVel, this._lastVelY);
      } else if (idleSec < 0.45) {
        this._targetAngleX =
          this._lastDir *
          PettingController._idleHoldAngleX *
          PettingController._pettingDirectionSign;
        this._targetAngleZ =
          -this._lastDir *
          PettingController._idleHoldAngleZ *
          PettingController._pettingDirectionSign;
        this._targetAngleY =
          -PettingController._idleHoldAngleY - this._lastDirY * PettingController._idleHoldAngleYDelta;
        this._targetBodyX = this._targetAngleX * 0.25;
        this._targetBodyY = Math.max(-2.6, Math.min(1.8, -0.7 - this._lastDirY * 1.3));
      } else {
        this._targetAngleX = 0;
        this._targetAngleZ = 0;
        this._targetAngleY = 0;
        this._targetBodyX = 0;
        this._targetBodyY = 0;
      }
    }

    // 头部与身体一阶滞后：运动响应快，回正慢
    const leanActive = this._leanEngaged && (Math.abs(this._leanX) > 0.01 || Math.abs(this._leanY) > 0.01);
    const tau = (this._pettingActive || leanActive)
      ? PettingController._headTauSeconds
      : PettingController._returnTauSeconds;
    const k = 1.0 - Math.exp(-dt / tau);
    const followW = 1 - PettingController._leanFollowDamp * Math.abs(this._leanX);
    const clampAbs = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    const goalAngleX = clampAbs(
      this._targetAngleX * followW + this._leanX * PettingController._leanAngleX,
      PettingController._maxTotalAngleX
    );
    // 实测模型 ParamAngleZ > 0 为头向右倾，与 AngleX 同号朝抚摸侧偏
    const goalAngleZ = clampAbs(
      this._targetAngleZ * followW + this._leanX * PettingController._leanAngleZ,
      PettingController._maxTotalAngleZ
    );
    const goalAngleY = clampAbs(
      this._targetAngleY + this._leanY * PettingController._leanAngleY,
      PettingController._maxTotalAngleY
    );
    const goalBodyX = clampAbs(
      this._targetBodyX * followW + this._leanX * PettingController._leanBodyX,
      PettingController._maxTotalBodyX
    );
    this._curAngleX +=
      (PettingController._clampHead(
        this._angleXMin,
        this._angleXMax,
        goalAngleX
      ) -
        this._curAngleX) *
      k;
    this._curAngleY +=
      (PettingController._clampHead(
        this._angleYMin,
        this._angleYMax,
        goalAngleY
      ) -
        this._curAngleY) *
      k;
    this._curAngleZ +=
      (PettingController._clampHead(
        this._angleZMin,
        this._angleZMax,
        goalAngleZ
      ) -
        this._curAngleZ) *
      k;
    this._curBodyX +=
      (PettingController._clampHead(this._bodyXMin, this._bodyXMax, goalBodyX) -
        this._curBodyX) *
      k;

    // 身体俯仰与侧倾、渐进红晕、猫耳放松、四腕微收与微笑微表情（识别到抚摸后激活，结束时平滑回 0）
    const activePetting = this.state === 'petting';
    const targetBodyY = activePetting
      ? PettingController._clampHead(this._bodyYMin, this._bodyYMax, this._targetBodyY)
      : 0;
    const followBodyZ = activePetting
      ? Math.max(-1.2, Math.min(1.2, this._targetAngleZ * followW * 0.12))
      : 0;
    const targetBodyZ = clampAbs(
      followBodyZ + this._leanX * PettingController._leanBodyZ,
      PettingController._maxTotalBodyZ
    );
    this._curBodyY += (targetBodyY - this._curBodyY) * k;
    this._curBodyZ += (targetBodyZ - this._curBodyZ) * k;
    if (Math.abs(this._curBodyY) < 0.001) this._curBodyY = 0;
    if (Math.abs(this._curBodyZ) < 0.001) this._curBodyZ = 0;

    const targetCheek = activePetting
      ? Math.min(0.55, 0.12 + (this._sessionElapsedMs / 8000) * 0.43 + Math.min(0.1, this.dailyState.headPettingCountToday * 0.03))
      : 0;
    const cheekK = 1.0 - Math.exp(-dt / (activePetting ? 0.35 : 0.22));
    this._curCheek += (targetCheek - this._curCheek) * cheekK;
    if (this._curCheek < 0.001) this._curCheek = 0;

    const earBase = activePetting ? Math.min(0.65, 0.45 + (this._sessionElapsedMs / 8000) * 0.2) : 0;
    const earVert = activePetting ? Math.max(-0.12, Math.min(0.12, (this._lastVelY / 300) * 0.12)) : 0;
    const earPitch = activePetting ? Math.max(0.2, Math.min(0.8, earBase + earVert)) : 0;
    const earLean = activePetting ? Math.max(-0.12, Math.min(0.12, (this._curAngleX / 16) * 0.12)) : 0;
    const earK = 1.0 - Math.exp(-dt / (activePetting ? 0.18 : 0.16));
    this._curEarL += ((earPitch + earLean) - this._curEarL) * earK;
    this._curEarR += ((earPitch - earLean) - this._curEarR) * earK;
    if (Math.abs(this._curEarL) < 0.001) this._curEarL = 0;
    if (Math.abs(this._curEarR) < 0.001) this._curEarR = 0;

    const armSway = activePetting ? this._curBodyX * 0.25 : 0;
    const armK = 1.0 - Math.exp(-dt / (activePetting ? 0.2 : 0.16));
    this._curArmL01 += ((activePetting ? -1.5 + armSway : 0) - this._curArmL01) * armK;
    this._curArmR01 += ((activePetting ? -1.5 - armSway : 0) - this._curArmR01) * armK;
    this._curArmL02 += ((activePetting ? -2.6 : 0) - this._curArmL02) * armK;
    this._curArmR02 += ((activePetting ? -2.6 : 0) - this._curArmR02) * armK;
    if (Math.abs(this._curArmL01) < 0.001) this._curArmL01 = 0;
    if (Math.abs(this._curArmR01) < 0.001) this._curArmR01 = 0;
    if (Math.abs(this._curArmL02) < 0.001) this._curArmL02 = 0;
    if (Math.abs(this._curArmR02) < 0.001) this._curArmR02 = 0;

    const microK = 1.0 - Math.exp(-dt / (activePetting ? 0.16 : 0.18));
    const targetSmile = activePetting ? Math.min(0.95, 0.75 + (this._sessionElapsedMs / 6000) * 0.2) : 0;
    this._curEyeSmile += (targetSmile - this._curEyeSmile) * microK;
    this._curMouthForm += ((activePetting ? 0.42 : 0) - this._curMouthForm) * microK;
    this._curBrowForm += ((activePetting ? 0.25 : 0) - this._curBrowForm) * microK;
    this._curBrowY += ((activePetting ? -0.1 : 0) - this._curBrowY) * microK;
    if (this._curEyeSmile < 0.001) this._curEyeSmile = 0;
    if (Math.abs(this._curMouthForm) < 0.001) this._curMouthForm = 0;
    if (Math.abs(this._curBrowForm) < 0.001) this._curBrowForm = 0;
    if (Math.abs(this._curBrowY) < 0.001) this._curBrowY = 0;

    // 写入
    try {
      target.setInteractionOffsets(
        this._curAngleX,
        this._curAngleY,
        this._curAngleZ,
        this._curBodyX
      );
      target.setBodyTilt?.(this._curBodyY, this._curBodyZ);
      const eyeEnabled = this._eyeOverrideActive && this._hasEyes;
      if (eyeEnabled) {
        target.setEyeOverride(true, this._eyeLMin, this._eyeRMin);
      } else {
        target.setEyeOverride(false, 0, 0);
      }
      target.setEarInteraction(this._curEarL !== 0 || this._curEarR !== 0, this._curEarL, this._curEarR);
      target.setFaceCheek(this._curCheek > 0, this._curCheek);

      const armActive = this._curArmL01 !== 0 || this._curArmL02 !== 0 ||
        this._curArmR01 !== 0 || this._curArmR02 !== 0;
      target.setArmInteraction?.(armActive, {
        armL01: this._curArmL01,
        armL02: this._curArmL02,
        armR01: this._curArmR01,
        armR02: this._curArmR02,
      });

      const microActive = this._curEyeSmile !== 0 || this._curMouthForm !== 0 ||
        this._curBrowForm !== 0 || this._curBrowY !== 0;
      target.setFaceMicroInteraction?.(microActive, {
        eyeSmile: this._curEyeSmile,
        mouthForm: this._curMouthForm,
        browForm: this._curBrowForm,
        browY: this._curBrowY,
      });
    } catch {
      // 写入失败不影响互动流程
    }

    this._updateSession(dtMs);
  }

  /** 会话台词计时（替代 Flutter 的 33ms Timer）。 */
  private _updateSession(dtMs: number): void {
    if (!this.isPettingModeActive) return;

    if (this.state === 'finishing') {
      // 完整恢复后释放参数所有权，下一次按下重新开始。
      if (performance.now() - this._finishingStartMs >= 600) {
        this.resetAll();
        this._sessionEnding = false;
        this._setState('inactive');
      }
      return;
    }

    if (this.state !== 'petting') return;

    // 停手不累计有效抚摸时间，也不把最后一次高速样本当作持续高速。
    const moving = performance.now() - this._lastInputMs < 120;
    if (moving) this._sessionElapsedMs += dtMs;
    const speed = Math.hypot(this.recognizer.smoothedVelXPxPerSec, this.recognizer.smoothedVelYPxPerSec);
    this._fastElapsedMs = moving && speed > 250
      ? this._fastElapsedMs + dtMs : 0;

    // 持续过快 0.8s 以上：每次会话最多一条 petting_fast
    if (
      !this._fastTriggered &&
      this._fastElapsedMs >= 800
    ) {
      this._fastTriggered = true;
      this._playTag('petting.fast');
      this.onStageEvent?.('fast');
      return;
    }

    // 持续约 10 秒：每次会话最多一条 petting_long
    if (!this._longTriggered && this._sessionElapsedMs >= 10000) {
      this._longTriggered = true;
      this._playTag('petting.long');
      this.onStageEvent?.('long');
      return;
    }

    // 持续 2~4 秒起触发 petting_soft / petting_active；最多 2 条，间隔至少 4 秒
    if (
      this._softActiveCount < 2 &&
      this._sessionElapsedMs >= 2000 &&
      this._sessionElapsedMs - this._lastSoftOrActiveMs >= 4000 &&
      !this._host.isDialogueActive() &&
      Math.random() < 0.6 * (dtMs / 33) // 保持与 33ms 节拍等价的触发率
    ) {
      this._softActiveCount++;
      this._lastSoftOrActiveMs = this._sessionElapsedMs;
      const stage = Math.random() < 0.5 ? 'soft' : 'active';
      this._playTag(`petting.${stage}`);
      this.onStageEvent?.(stage);
    }
  }

  private _onPettingStarted(): void {
    const count = this.dailyState.headPettingCountToday;
    const repeatChance =
      count >= 2 ? Math.min(0.8, 0.25 + 0.15 * (count - 2)) : 0.0;
    const stage = Math.random() < repeatChance ? 'repeat' : 'start';
    this.onStageEvent?.(stage);
    if (this._host.isDialogueActive()) return;
    if (Math.random() >= 0.4) return;
    this._playTag(`petting.${stage}`);
  }

  private _playTag(trigger: string): void {
    if (this._host.isDialogueActive()) return;
    const id = this._react(trigger, new Set(this.dailyState.lastPettingDialogueIds));
    if (id) this.dailyState.recordDialogueId(id);
  }

  private _ensureConfigured(target: InteractionTarget): void {
    if (this._configured) return;
    this._configured = true;
    try {
      const info = target.getInteractionParamInfo();
      if (!info) return;
      this._angleXMin = info.angleXMin;
      this._angleXMax = info.angleXMax;
      this._angleYMin = info.angleYMin;
      this._angleYMax = info.angleYMax;
      this._angleZMin = info.angleZMin;
      this._angleZMax = info.angleZMax;
      this._bodyXMin = info.bodyXMin;
      this._bodyXMax = info.bodyXMax;
      this._bodyYMin = info.bodyYMin ?? -10;
      this._bodyYMax = info.bodyYMax ?? 10;
      this._eyeLMin = info.eyeLMin;
      this._eyeLMax = info.eyeLMax;
      this._eyeRMin = info.eyeRMin;
      this._eyeRMax = info.eyeRMax;
      this._hasEyes = info.hasEyes;
      this._available = true;
    } catch {
      // 互动参数检测失败：互动静默失活
    }
  }

  /** 模型重载后重置配置缓存，下次 tick 自动重新探测。 */
  resetConfiguration(): void {
    this._configured = false;
    this._available = false;
    this._hasEyes = false;
    this._lastLookAtReduction = false;
  }

  private _setState(next: PettingState): void {
    this.state = next;
  }

  private _updatePettingHaptic(
    ctx: PointerContext,
    directionReversed: boolean,
    velX: number,
    now: number
  ): void {
    const stepPx = Math.hypot(ctx.pxX - this._hapticLastX, ctx.pxY - this._hapticLastY);
    this._hapticLastX = ctx.pxX;
    this._hapticLastY = ctx.pxY;
    // 忽略手指静止时的亚像素传感器抖动
    if (stepPx >= 1.0) this._hapticAccumPx += stepPx;

    const elapsed = now - this._hapticLastMs;
    if (directionReversed && elapsed >= 42 && this._hapticAccumPx >= 5) {
      this._hapticAccumPx = 0;
      this._hapticLastMs = now;
      this._emitHaptic('reverse', velX);
      return;
    }
    if (elapsed >= 45 && this._hapticAccumPx >= 11) {
      this._hapticAccumPx = 0;
      this._hapticLastMs = now;
      this._emitHaptic('stroke', velX);
    }
  }

  private _emitHaptic(kind: PettingHapticPulse['kind'], velX: number): void {
    if (!this.onHaptic) return;
    const speedNorm = Math.min(1, Math.max(0, (Math.abs(velX) - 60) / 260));
    if (kind === 'start') {
      this.onHaptic({ kind, durationMs: 16, amplitude: 90 });
      return;
    }
    if (kind === 'reverse') {
      this.onHaptic({
        kind,
        durationMs: Math.round(12 + speedNorm * 3),
        amplitude: Math.round(80 + speedNorm * 35),
      });
      return;
    }
    this.onHaptic({
      kind,
      durationMs: Math.round(10 + speedNorm * 3),
      amplitude: Math.round(55 + speedNorm * 45),
    });
  }

  private static _clampHead(min: number, max: number, v: number): number {
    if (min >= max) return v;
    return Math.min(Math.max(v, min), max);
  }
}
