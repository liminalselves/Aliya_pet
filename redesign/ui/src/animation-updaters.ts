import { CubismModel } from '@framework/model/cubismmodel';
import { CubismBreath } from '@framework/effect/cubismbreath';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismBreathUpdater } from '@framework/motion/cubismbreathupdater';
import { CubismEyeBlinkUpdater } from '@framework/motion/cubismeyeblinkupdater';
import { CubismExpressionUpdater } from '@framework/motion/cubismexpressionupdater';
import { CubismExpressionMotionManager } from '@framework/motion/cubismexpressionmotionmanager';

/** 动作期间也推进眨眼相位；进出动作都做平滑过渡，避免眨眼中途切入动作或退出时跳变。 */
export class ContinuousEyeBlinkUpdater extends CubismEyeBlinkUpdater {
  private static readonly HANDOFF_SECONDS = 0.18;
  private _wasMotion = false;
  private _hasIdle = false;
  private _releaseElapsed = ContinuousEyeBlinkUpdater.HANDOFF_SECONDS;
  private _enterElapsed = ContinuousEyeBlinkUpdater.HANDOFF_SECONDS;
  private _last: number[] = [];
  private _from: number[] = [];
  private _lastIdle: number[] = [];
  private _enterFrom: number[] = [];
  constructor(private readonly motionActive: () => boolean, private readonly blink: CubismEyeBlink) {
    super(motionActive, blink);
  }
  onLateUpdate(model: CubismModel, dt: number): void {
    if (!model) return;
    const ids = this.blink.getParameterIds();
    const motion = this.motionActive();
    const values = motion ? ids.map(id => model.getParameterValueById(id)) : [];
    this.blink.updateParameters(model, dt);
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    if (motion) {
      if (!this._wasMotion && this._hasIdle) {
        // 仅当自然眨眼正处于闭合/半闭状态时才平缓拉回，避免把清醒态的动作曲线拦在 1.0。
        const midBlink = this._lastIdle.some((v, i) => v < 0.99 && Math.abs(values[i] - v) > 0.01);
        if (midBlink) {
          this._enterFrom = this._lastIdle.slice();
          this._enterElapsed = 0;
        } else {
          this._enterElapsed = ContinuousEyeBlinkUpdater.HANDOFF_SECONDS;
        }
      }
      if (this._enterElapsed < ContinuousEyeBlinkUpdater.HANDOFF_SECONDS && this._enterFrom.length === ids.length) {
        this._enterElapsed = Math.min(ContinuousEyeBlinkUpdater.HANDOFF_SECONDS, this._enterElapsed + step);
        const t = this._enterElapsed / ContinuousEyeBlinkUpdater.HANDOFF_SECONDS;
        const k = t * t * (3 - 2 * t);
        const displayed = values.map((v, i) => this._enterFrom[i] + (v - this._enterFrom[i]) * k);
        ids.forEach((id, i) => model.setParameterValueById(id, displayed[i]));
        this._last = displayed;
      } else {
        ids.forEach((id, i) => model.setParameterValueById(id, values[i]));
        this._last = values;
      }
    } else {
      if (this._wasMotion) {
        this._from = this._last;
        this._releaseElapsed = 0;
      }
      this._releaseElapsed = Math.min(ContinuousEyeBlinkUpdater.HANDOFF_SECONDS, this._releaseElapsed + step);
      if (this._releaseElapsed < ContinuousEyeBlinkUpdater.HANDOFF_SECONDS) {
        const t = this._releaseElapsed / ContinuousEyeBlinkUpdater.HANDOFF_SECONDS;
        const k = t * t * (3 - 2 * t);
        ids.forEach((id, i) => {
          const base = model.getParameterValueById(id);
          model.setParameterValueById(id, this._from[i] + (base - this._from[i]) * k);
        });
      }
      this._lastIdle = ids.map(id => model.getParameterValueById(id));
      this._hasIdle = true;
    }
    this._wasMotion = motion;
  }
}

/** 呼吸头身摆动在动作播放期间平滑减幅，保留胸腔 ParamBreath 完整周期。 */
export class AttenuatedBreathUpdater extends CubismBreathUpdater {
  private static readonly TAU_SECONDS = 0.25;
  private _swayScale = 1;
  private _baseWeights: number[] | null = null;
  constructor(
    private readonly motionActive: () => boolean,
    private readonly breathInstance: CubismBreath,
    private readonly breathParamId: CubismIdHandle,
    private readonly activeScale = 0.35,
  ) {
    super(breathInstance);
  }
  onLateUpdate(model: CubismModel, dt: number): void {
    if (!model) return;
    const params = this.breathInstance.getParameters();
    if (!this._baseWeights) this._baseWeights = params.map(p => p.weight);
    const step = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const target = this.motionActive() ? this.activeScale : 1;
    const k = step > 0 ? 1 - Math.exp(-step / AttenuatedBreathUpdater.TAU_SECONDS) : 1;
    this._swayScale += (target - this._swayScale) * k;
    for (let i = 0; i < params.length; i++) {
      params[i].weight = params[i].parameterId === this.breathParamId
        ? this._baseWeights[i]
        : this._baseWeights[i] * this._swayScale;
    }
    super.onLateUpdate(model, dt);
  }
}

/** SDK 表情管理器只在最新表情淡入完成时清队列；连点时也回收已淡出条目。 */
export class FadingExpressionUpdater extends CubismExpressionUpdater {
  constructor(private readonly manager: CubismExpressionMotionManager) {
    super(manager);
  }
  onLateUpdate(model: CubismModel, dt: number): void {
    if (!model) return;
    const entries = this.manager.getCubismMotionQueueEntries();
    const time = this.manager._userTimeSeconds + dt;
    for (let i = entries.length - 2; i >= 0; i--) {
      const end = entries[i].getEndTime();
      if (end >= 0 && end <= time) {
        entries[i].release();
        entries.splice(i, 1);
      }
    }
    super.onLateUpdate(model, dt);
  }
}
