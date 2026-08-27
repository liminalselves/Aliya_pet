/**
 * 人物互动统一入口（移植自 Flutter InteractionService，逻辑等价）：
 * 区域识别、手势识别、台词抽取与参数动画全部集中在此。
 * 上层（PetApp）仅转发指针输入并负责气泡/窗口拖动的呈现。
 */

import { HitAreas } from './hit-areas';
import {
  PettingController,
  PettingDialogueHost,
} from './petting-controller';
import { PointerContext } from './petting-recognizer';
import {
  ClickResult,
  ClickSequenceService,
  DragReactionService,
  PointerProximityService,
  ProceduralReactionService,
  ProceduralReactions,
} from './procedural';
import { InteractionTarget } from './target';

export class InteractionService {
  readonly hitAreas: HitAreas;
  readonly petting: PettingController;
  readonly clickSequence = new ClickSequenceService();
  readonly proximity = new PointerProximityService();
  readonly dragReaction = new DragReactionService();
  readonly procedural: ProceduralReactionService;

  /** 点击台词请求（上层提供：播放一条 user_click 台词）。 */
  playClickDialogue: (() => void) | null = null;

  /** 当前是否有台词在播放（上层提供）。 */
  isDialogueActive: (() => boolean) | null = null;

  // 追踪指针位置以计算拖动速度
  private _lastPxX = 0;
  private _lastPxY = 0;

  constructor(deps: {
    hitAreas: HitAreas;
    getTarget: () => InteractionTarget | null;
    pettingHost: PettingDialogueHost;
    dialogue: ConstructorParameters<typeof PettingController>[0]['dialogue'];
    playCharacterAction: (action: string) => boolean;
  }) {
    this.hitAreas = deps.hitAreas;
    this.petting = new PettingController({
      hitAreas: deps.hitAreas,
      getTarget: deps.getTarget,
      dialogue: deps.dialogue,
      host: deps.pettingHost,
    });
    this.procedural = new ProceduralReactionService({
      getTarget: deps.getTarget,
      isPettingActive: () => this.petting.isPettingSessionActive,
      playCharacterAction: deps.playCharacterAction,
    });
  }

  get isPettingModeActive(): boolean {
    return this.petting.isPettingModeActive;
  }

  /** 当前平滑水平速度（供手掌指针旋转，后续接光标时用）。 */
  get smoothedVelocityXPxPerSec(): number {
    return this.petting.smoothedVelocityXPxPerSec;
  }

  /** 指针移动。返回 true=互动已接管（上层不移动窗口/不处理拖动）。 */
  onPointerMove(ctx: PointerContext): boolean {
    this.proximity.update(ctx);

    // 把拖动速度喂给 dragReaction，使快速拖动反应链生效
    if (this.dragReaction.isDragging && ctx.dtSeconds > 0) {
      const dx = ctx.pxX - this._lastPxX;
      const dy = ctx.pxY - this._lastPxY;
      const speed = Math.sqrt(dx * dx + dy * dy) / ctx.dtSeconds;
      this.dragReaction.onDragMove(speed);
    }
    this._lastPxX = ctx.pxX;
    this._lastPxY = ctx.pxY;

    if (this.petting.onPointerMove(ctx)) return true;
    return false;
  }

  /** 指针按下。返回 true=互动已接管（上层不开始拖动）。 */
  onPointerDown(ctx: PointerContext): boolean {
    this.proximity.update(ctx);
    this._lastPxX = ctx.pxX;
    this._lastPxY = ctx.pxY;

    if (this.petting.onPointerDown(ctx)) return true;
    if (!this.isPettingModeActive) {
      this.dragReaction.beginDrag();
    }
    return false;
  }

  /** 指针松开。返回 true=互动已接管（上层不处理单击）。 */
  onPointerUp(ctx: PointerContext): boolean {
    this.proximity.update(ctx);
    if (this.petting.onPointerUp(ctx)) return true;
    return false;
  }

  /**
   * 普通单击（非抚摸接管，上层在单击确认后调用）。
   * 返回 true 表示应抑制常规点击台词（点击冷却/疑惑反应等）。
   */
  onClick(ctx: PointerContext, wasDrag: boolean): boolean {
    if (wasDrag) {
      const wasFast = this.dragReaction.endDrag();
      if (wasFast) {
        this.procedural.apply(ProceduralReactions.eyesWiden(1.0));
        // 每次快速拖动触发一次台词
        if (this.isDialogueActive?.() !== true) {
          this.playClickDialogue?.();
        }
      }
      return false;
    }

    const result = this.clickSequence.registerClick();
    if (result === ClickResult.cooldown) {
      return true; // 点击冷却中，抑制点击台词
    }

    const area = this.hitAreas.hitAreaAt(ctx.normX, ctx.normY);
    switch (area) {
      case 'head':
        this.procedural.apply(ProceduralReactions.eyesAndTilt(0.8));
        break;
      case 'face':
        // 点脸脸红：全局视线跟随光标，故不使用"移开视线"反应（会互相冲突）
        this.procedural.apply(ProceduralReactions.blush(1.0));
        break;
      case 'ear_left':
      case 'ear_right':
        this.procedural.apply(ProceduralReactions.earTwitch(0.8, area));
        break;
    }

    if (result === ClickResult.doubt) {
      this.procedural.apply(ProceduralReactions.doubt(0.9));
      return true; // 疑惑反应替代常规点击台词
    }
    return false;
  }

  onEsc(): void {
    this.petting.onEsc();
  }

  /** 切换角色 / 重载模型时调用：退出抚摸并重置互动参数。 */
  onModelReloaded(): void {
    this.petting.exitPettingMode('modelReload');
    this.petting.resetConfiguration();
    this.procedural.cancelAll();
  }

  /** 关闭窗口时调用：完整清理，不残留参数覆盖。 */
  onWindowClosed(): void {
    this.petting.exitPettingMode('windowClosing');
    this.procedural.cancelAll();
    this.clickSequence.reset();
    this.proximity.reset();
  }

  /** 每帧驱动（由渲染循环调用）。 */
  tick(dtMs: number): void {
    this.petting.tick(dtMs);
    this.procedural.tick();
  }
}
