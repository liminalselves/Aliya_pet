/**
 * 抚摸控制器（移植自 Flutter HeadPettingService + PettingReactionController +
 * InteractionStateService，三者合并为一个每帧驱动的控制器）：
 *
 * 状态机：Inactive → Armed → HoveringHead → Pressed → Petting → Finishing → Armed
 *   - 仅右键（isSecondary）在头部抚摸区按下进入；Esc / 再次结束 → Inactive
 *   - 识别到有效抚摸手势后才闭眼；单击头部走普通点击互动
 *
 * 反应（全部经 InteractionTarget 通道写入）：
 *   - 头部跟随：非线性响应 sign·|v/vref|^0.65，一阶滞后（运动 tau 0.10s / 回正 0.16s）
 *   - 静止姿态：短暂停手（<0.45s）保留最后方向 25~35% + 轻微低头
 *   - 抚摸闭眼 180~320ms、结束睁眼 280~500ms，完成后恢复自动眨眼
 *
 * 台词触发：petting_start 40%（当日次数加成 repeat）/ fast(>250px/s 持续 0.8s) /
 *   long(10s) / soft·active(2~4s 起，最多 2 条间隔 4s，60%) / end(>1s 主动结束 30%)
 */

import { DialogueStore, ResolvedDialogue } from '../dialogue/dialogue';
import { HitAreas } from './hit-areas';
import {
  PettingGestureRecognizer,
  PointerContext,
} from './petting-recognizer';
import { InteractionTarget } from './target';

export type PettingState =
  | 'inactive'
  | 'armed'
  | 'hoveringHead'
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

/** 抚摸台词宿主（由上层实现：取消当前会话并播放）。 */
export interface PettingDialogueHost {
  /** 当前是否正在播放高优先级台词（抚摸开始台词不打断它）。 */
  isDialogueActive(): boolean;
  /** 播放一条抚摸台词（会取消之前的台词会话）。 */
  playPettingDialogue(resolved: ResolvedDialogue): void;
}

type EyeState = 'idle' | 'closing' | 'opening';

/** 当日互动状态（跨天自动清零）。 */
class DailyInteractionState {
  headPettingCountToday = 0;
  headPettingDurationTodayMs = 0;
  longestPettingDurationMs = 0;
  readonly lastPettingDialogueIds: string[] = [];
  private _lastDay = DailyInteractionState._today();

  private static _today(): string {
    const n = new Date();
    return `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}`;
  }

  ensureDayFresh(): void {
    const today = DailyInteractionState._today();
    if (today !== this._lastDay) {
      this._lastDay = today;
      this.headPettingCountToday = 0;
      this.headPettingDurationTodayMs = 0;
      this.longestPettingDurationMs = 0;
      this.lastPettingDialogueIds.length = 0;
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
  readonly dailyState = new DailyInteractionState();

  state: PettingState = 'inactive';

  private readonly _hitAreas: HitAreas;
  private readonly _getTarget: () => InteractionTarget | null;
  private readonly _dialogue: DialogueStore;
  private readonly _host: PettingDialogueHost;

  // 会话计时
  private _sessionStartMs = 0;
  private _sessionElapsedMs = 0;
  private _lastSoftOrActiveMs = 0;
  private _softActiveCount = 0;
  private _fastTriggered = false;
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
  private _eyeLMin = 0;
  private _eyeLMax = 1;
  private _eyeRMin = 0;
  private _eyeRMax = 1;

  // 当前平滑值 / 目标值
  private _curAngleX = 0;
  private _curAngleY = 0;
  private _curAngleZ = 0;
  private _curBodyX = 0;
  private _targetAngleX = 0;
  private _targetAngleY = 0;
  private _targetAngleZ = 0;

  // 眼睛
  private _eyeState: EyeState = 'idle';
  private _eyeOpenness = 1.0;
  private _eyeOverrideActive = false;

  // ---- 头部跟随参数（度）----
  private static readonly _maxAngleX = 7.0;
  private static readonly _maxAngleZ = 9.0;
  private static readonly _maxAngleY = 2.5;
  private static readonly _pettingDirectionSign = 1.0;
  private static readonly _velocityReference = 300.0;
  private static readonly _minAngleX = 2.2;
  private static readonly _minAngleZ = 2.8;
  private static readonly _idleHoldAngleX = 2.0;
  private static readonly _idleHoldAngleZ = 2.6;
  private static readonly _idleHoldAngleY = 1.5;

  private _pettingActive = false;
  private _lastVel = 0;
  private _lastDir = 0;
  private _lastInputMs = 0;

  private static readonly _headTauSeconds = 0.1;
  private static readonly _returnTauSeconds = 0.16;

  private _lastLookAtReduction = false;

  /** 抚摸会话结束回调（上层用于收尾光标等）。 */
  onSessionEnded: ((reason: PettingEndReason) => void) | null = null;

  constructor(deps: {
    hitAreas: HitAreas;
    getTarget: () => InteractionTarget | null;
    dialogue: DialogueStore;
    host: PettingDialogueHost;
  }) {
    this._hitAreas = deps.hitAreas;
    this._getTarget = deps.getTarget;
    this._dialogue = deps.dialogue;
    this._host = deps.host;
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
    const inZone = this._hitAreas.isInHeadPetZone(ctx.normX, ctx.normY);

    if (!this.isPettingModeActive) return false;

    if (
      this.state === 'armed' ||
      this.state === 'hoveringHead' ||
      this.state === 'finishing'
    ) {
      if (this.state === 'armed' && inZone) {
        this._setState('hoveringHead');
      } else if (this.state === 'hoveringHead' && !inZone) {
        this._setState('armed');
      }
    }

    if (this.state === 'pressed' || this.state === 'petting') {
      const result = this.recognizer.update(ctx);
      this._lastInputMs = performance.now();
      this.setVelocity(result.smoothedVelX, true);
      if (result.isValid && this.state === 'pressed') {
        this._beginEyeClose(); // 识别到抚摸手势（按住并滑动）后闭眼
        this._setState('petting');
        this._onPettingStarted();
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
    if (!ctx.isSecondary) return false;

    const inZone = this._hitAreas.isInHeadPetZone(ctx.normX, ctx.normY);
    if (!this.isPettingModeActive) {
      // 兜底：按下时若尚未进入但位于头部区域，先自动进入
      if (inZone) {
        this._enterPettingMode();
      } else {
        return false;
      }
    }

    if (
      this.state === 'armed' ||
      this.state === 'hoveringHead' ||
      this.state === 'finishing'
    ) {
      if (inZone) {
        this._sessionEnding = false; // 先取消旧恢复再创建新会话
        this._sessionStartMs = performance.now();
        this._sessionElapsedMs = 0;
        this._softActiveCount = 0;
        this._lastSoftOrActiveMs = 0;
        this._fastTriggered = false;
        this._longTriggered = false;
        this._endDialogueTriggered = false;
        this._lastInputMs = performance.now();
        this.recognizer.startGesture();
        // 不立即闭眼：单击头部应走普通点击互动
        this.dailyState.beginPetting();
        this._setState('pressed');
        return true;
      }
      return false; // 按住身体区域：交还上层
    }
    return false;
  }

  /** 指针松开。返回 true 表示互动已接管。 */
  onPointerUp(_ctx: PointerContext): boolean {
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

  private _enterPettingMode(): void {
    if (this.state !== 'inactive') return;
    this.dailyState.ensureDayFresh();
    this._setState('armed');
  }

  exitPettingMode(reason: PettingEndReason): void {
    if (this.state === 'inactive') return;
    if (this.isPettingSessionActive) {
      this.endPettingSession(reason);
    }
    this.recognizer.endGesture();
    this.resetAll();
    this._sessionEnding = false;
    this._setState('inactive');
  }

  /** 统一结束方法：停止采样 → Finishing → 睁眼恢复 → 头部回正。 */
  endPettingSession(reason: PettingEndReason): void {
    if (!this.isPettingSessionActive || this._sessionEnding) return;
    this._sessionEnding = true;

    this.recognizer.endGesture();
    this._setState('finishing');
    this.setVelocity(0, false);
    this._beginEyeOpen();

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
      this._playTag('petting_end');
    }

    this._finishingStartMs = performance.now();
    this.onSessionEnded?.(reason);
  }

  // ---------- 反应：目标计算 ----------

  /** 按平滑水平速度设置头部目标（petting=false 时全部回正）。 */
  setVelocity(velXPxPerSec: number, petting: boolean): void {
    this._lastInputMs = performance.now();
    if (!petting) {
      this._pettingActive = false;
      this._lastVel = 0;
      this._lastDir = 0;
      this._targetAngleX = 0;
      this._targetAngleY = 0;
      this._targetAngleZ = 0;
      this._applyLookAtReduction(false);
      return;
    }
    this._pettingActive = true;
    this._lastVel = Math.min(Math.max(velXPxPerSec, -800), 800);
    if (Math.abs(this._lastVel) > 20) {
      this._lastDir = Math.sign(this._lastVel);
    }
    this._applyLookAtReduction(true);
    this._computePettingTargets(this._lastVel);
  }

  /** 非线性响应：低速也有明显反馈，高速仍受上限限制。 */
  private _computePettingTargets(vel: number): void {
    const normalized = Math.min(
      Math.max(vel / PettingController._velocityReference, -1),
      1
    );
    const response = Math.sign(normalized) * Math.pow(Math.abs(normalized), 0.65);
    let angleX = response * PettingController._maxAngleX * PettingController._pettingDirectionSign;
    let angleZ = -response * PettingController._maxAngleZ * PettingController._pettingDirectionSign;

    // 有效抚摸最低反馈
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

    this._targetAngleX = angleX;
    this._targetAngleZ = angleZ;
    this._targetAngleY = -PettingController._maxAngleY; // 轻微低头
  }

  private _beginEyeClose(): void {
    this._eyeState = 'closing';
    this._eyeOverrideActive = true;
  }

  private _beginEyeOpen(): void {
    this._eyeState = 'opening';
    this._eyeOverrideActive = true;
  }

  /** 立即复位全部互动参数（退出抚摸/异常恢复）。 */
  resetAll(): void {
    this._curAngleX = this._curAngleY = this._curAngleZ = this._curBodyX = 0;
    this._eyeState = 'idle';
    this._eyeOpenness = 1.0;
    this._eyeOverrideActive = false;
    this._pettingActive = false;
    this._lastDir = 0;
    this._applyLookAtReduction(false, true);
    const target = this._getTarget();
    if (target) {
      try {
        target.setInteractionOffsets(0, 0, 0, 0);
        target.setEyeOverride(false, 0, 0);
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
    if (!this._available) return;

    const dt = Math.min(Math.max(dtMs / 1000, 0.001), 0.1);

    this._updateEye(dt);

    // 目标选择：运动中 → 运动目标；短暂停止 → 放松静止姿态；长时间停止 → 回中
    const idleSec = (performance.now() - this._lastInputMs) / 1000;
    if (this._pettingActive) {
      if (idleSec < 0.08) {
        this._computePettingTargets(this._lastVel);
      } else if (idleSec < 0.45) {
        this._targetAngleX =
          this._lastDir *
          PettingController._idleHoldAngleX *
          PettingController._pettingDirectionSign;
        this._targetAngleZ =
          -this._lastDir *
          PettingController._idleHoldAngleZ *
          PettingController._pettingDirectionSign;
        this._targetAngleY = -PettingController._idleHoldAngleY;
      } else {
        this._targetAngleX = 0;
        this._targetAngleZ = 0;
        this._targetAngleY = 0;
      }
    }

    // 头部一阶滞后：运动响应快，回正慢
    const tau = this._pettingActive
      ? PettingController._headTauSeconds
      : PettingController._returnTauSeconds;
    const k = 1.0 - Math.exp(-dt / tau);
    this._curAngleX +=
      (PettingController._clampHead(
        this._angleXMin,
        this._angleXMax,
        this._targetAngleX
      ) -
        this._curAngleX) *
      k;
    this._curAngleY +=
      (PettingController._clampHead(
        this._angleYMin,
        this._angleYMax,
        this._targetAngleY
      ) -
        this._curAngleY) *
      k;
    this._curAngleZ +=
      (PettingController._clampHead(
        this._angleZMin,
        this._angleZMax,
        this._targetAngleZ
      ) -
        this._curAngleZ) *
      k;
    this._curBodyX +=
      (PettingController._clampHead(this._bodyXMin, this._bodyXMax, 0) -
        this._curBodyX) *
      k;

    // 写入
    try {
      target.setInteractionOffsets(
        this._curAngleX,
        this._curAngleY,
        this._curAngleZ,
        this._curBodyX
      );
      const eyeEnabled = this._eyeOverrideActive && this._hasEyes;
      if (eyeEnabled) {
        target.setEyeOverride(
          true,
          this._eyeLMin + this._eyeOpenness * (this._eyeLMax - this._eyeLMin),
          this._eyeRMin + this._eyeOpenness * (this._eyeRMax - this._eyeRMin)
        );
      } else {
        target.setEyeOverride(false, 0, 0);
      }
    } catch {
      // 写入失败不影响互动流程
    }

    this._updateSession(dtMs);
  }

  private _updateEye(dt: number): void {
    switch (this._eyeState) {
      case 'closing': {
        const k = 1.0 - Math.exp(-dt / 0.25);
        this._eyeOpenness += (0 - this._eyeOpenness) * k;
        if (this._eyeOpenness < 0.02) {
          this._eyeOpenness = 0;
          this._eyeState = 'idle'; // 维持闭合
        }
        break;
      }
      case 'opening': {
        const k = 1.0 - Math.exp(-dt / 0.38);
        this._eyeOpenness += (1 - this._eyeOpenness) * k;
        if (this._eyeOpenness > 0.98) {
          this._eyeOpenness = 1;
          this._eyeState = 'idle';
          this._eyeOverrideActive = false; // 恢复自动眨眼
        }
        break;
      }
      case 'idle':
        break;
    }
  }

  /** 会话台词计时（替代 Flutter 的 33ms Timer）。 */
  private _updateSession(dtMs: number): void {
    if (!this.isPettingModeActive) return;

    if (this.state === 'finishing') {
      // 恢复参数（约 600ms）后回到 Armed
      if (performance.now() - this._finishingStartMs >= 600) {
        this._sessionEnding = false;
        this._setState('armed');
      }
      return;
    }

    if (this.state !== 'petting') return;

    this._sessionElapsedMs += dtMs;

    // 持续过快 0.8s 以上：每次会话最多一条 petting_fast
    if (
      !this._fastTriggered &&
      this._sessionElapsedMs > 800 &&
      Math.abs(this.recognizer.smoothedVelXPxPerSec) > 250
    ) {
      this._fastTriggered = true;
      this._playTag('petting_fast');
      return;
    }

    // 持续约 10 秒：每次会话最多一条 petting_long
    if (!this._longTriggered && this._sessionElapsedMs >= 10000) {
      this._longTriggered = true;
      this._playTag('petting_long');
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
      const tag = Math.random() < 0.5 ? 'petting_soft' : 'petting_active';
      this._playTag(tag);
    }
  }

  private _onPettingStarted(): void {
    if (this._host.isDialogueActive()) return;
    if (Math.random() >= 0.4) return;

    const count = this.dailyState.headPettingCountToday;
    const repeatChance =
      count >= 2 ? Math.min(0.8, 0.25 + 0.15 * (count - 2)) : 0.0;
    const tag =
      Math.random() < repeatChance ? 'petting_repeat' : 'petting_start';
    const boost = tag === 'petting_repeat' ? count : 0.0;
    this._playTag(tag, boost);
  }

  private _playTag(tag: string, boost = 0): void {
    const resolved = this._dialogue.resolveSceneTag(
      'head_petting',
      tag,
      new Set(this.dailyState.lastPettingDialogueIds),
      boost
    );
    if (!resolved) return;
    this.dailyState.recordDialogueId(resolved.entryId);
    this._host.playPettingDialogue(resolved);
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

  private static _clampHead(min: number, max: number, v: number): number {
    if (min >= max) return v;
    return Math.min(Math.max(v, min), max);
  }
}
