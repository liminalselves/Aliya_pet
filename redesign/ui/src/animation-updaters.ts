import { CubismModel } from '@framework/model/cubismmodel';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { CubismEyeBlinkUpdater } from '@framework/motion/cubismeyeblinkupdater';
import { CubismExpressionUpdater } from '@framework/motion/cubismexpressionupdater';
import { CubismExpressionMotionManager } from '@framework/motion/cubismexpressionmotionmanager';

/** 动作期间也推进眨眼相位，避免接管结束后恢复被暂停的闭眼帧。 */
export class ContinuousEyeBlinkUpdater extends CubismEyeBlinkUpdater {
  private _wasMotion = false;
  private _releaseElapsed = 1;
  private _last: number[] = [];
  private _from: number[] = [];
  constructor(private readonly motionActive: () => boolean, private readonly blink: CubismEyeBlink) {
    super(motionActive, blink);
  }
  onLateUpdate(model: CubismModel, dt: number): void {
    if (!model) return;
    const ids = this.blink.getParameterIds();
    const motion = this.motionActive();
    const values = motion ? ids.map(id => model.getParameterValueById(id)) : [];
    this.blink.updateParameters(model, dt);
    if (motion) {
      ids.forEach((id, i) => model.setParameterValueById(id, values[i]));
      this._last = values;
    } else {
      if (this._wasMotion) {
        this._from = this._last;
        this._releaseElapsed = 0;
      }
      this._releaseElapsed = Math.min(0.18, this._releaseElapsed + Math.max(0, dt));
      if (this._releaseElapsed < 0.18) {
        const t = this._releaseElapsed / 0.18;
        const k = t * t * (3 - 2 * t);
        ids.forEach((id, i) => {
          const base = model.getParameterValueById(id);
          model.setParameterValueById(id, this._from[i] + (base - this._from[i]) * k);
        });
      }
    }
    this._wasMotion = motion;
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
