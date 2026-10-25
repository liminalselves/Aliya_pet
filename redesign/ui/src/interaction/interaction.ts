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
  private _earClickUntilMs = 0;
  private _basicClickUntilMs = 0;

  /** 点击台词请求（上层提供：按语义标签播放对应台词）。 */
  playClickDialogue: ((tag: string) => void) | null = null;

  /** 当前是否有台词在播放（上层提供）。 */
  isDialogueActive: (() => boolean) | null = null;

  get isBusy(): boolean {
    return this.petting.isPettingSessionActive || this.procedural.isPlaying || this.dragReaction.isDragging;
  }

  /** 系统取消与失焦统一释放所有手势，取消不产生台词。 */
  cancel(): void {
    this.petting.exitPettingMode('gestureCanceled');
    this.procedural.cancelAll();
    this.dragReaction.cancel();
    this.clickSequence.reset();
    this._earClickUntilMs = 0;
    this._basicClickUntilMs = 0;
  }


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
      takeOverPetting: () => this.petting.releaseFinishing(),
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

    if (this.petting.onPointerMove(ctx)) return true;
    return false;
  }

  /** 指针按下。返回 true=互动已接管（上层不开始拖动）。 */
  onPointerDown(ctx: PointerContext): boolean {
    this.proximity.update(ctx);

    if (!ctx.isSecondary && this.isPettingModeActive) {
      this.petting.exitPettingMode('modeChanged');
    }
    if (this.petting.onPointerDown(ctx)) {
      this.procedural.cancelAll(true);
      this.dragReaction.cancel();
      return true;
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
          this.playClickDialogue?.('drag_fast');
        }
      }
      return false;
    }

    this.dragReaction.cancel();
    const area = this.hitAreas.hitAreaAt(ctx.normX, ctx.normY);
    // 耳朵不计入普通疑惑连点，但保留其历史与全局冷却。
    if (area === 'ear_left' || area === 'ear_right') {
      const now = performance.now();
      if (this.clickSequence.isInCooldown) {
        this._acknowledgeCooldownClick();
        return true;
      }
      if (now < this._earClickUntilMs) return true;
      // 左右耳共用一次反馈时窗，避免连点反复启动 120+60+240ms 的单眼动作。
      this._earClickUntilMs = now + 420;
      this.procedural.apply(ProceduralReactions.earBlink(0.8, area));
      if (this.isDialogueActive?.() !== true) this.playClickDialogue?.(area);
      return true;
    }
    const result = this.clickSequence.registerClick();
    if (result === ClickResult.cooldown) {
      this._acknowledgeCooldownClick();
      return true; // 冷却只抑制台词/连击动作，不吞掉基础视觉反馈。
    }

    if (result === ClickResult.doubt || result === ClickResult.comment) {
      this.procedural.apply(ProceduralReactions.doubt(0.9));
      this.playClickDialogue?.(result === ClickResult.doubt ? 'click_doubt' : 'click_comment');
      return true;
    }

    switch (area) {
      case 'head':
      case 'head_pet_zone':
      case 'hair':
        this.procedural.apply(ProceduralReactions.eyesAndTilt(0.8));
        break;
      case 'face':
        // 点脸脸红：全局视线跟随光标，故不使用"移开视线"反应（会互相冲突）
        this.procedural.apply(ProceduralReactions.blush(1.0));
        break;
      default:
        // 身体、手部、平板及未命名的可见区域也有独立反馈，不依赖台词成功播放。
        this.procedural.apply(ProceduralReactions.acknowledge(0.8));
        break;
    }

    this.playClickDialogue?.(area === 'head_pet_zone' ? 'head' : area ?? 'body');
    return true;
  }

  /** 冷却期间只允许低幅度点头；限频不延长台词冷却，也不触发角色动作。 */
  private _acknowledgeCooldownClick(): void {
    const now = performance.now();
    if (now < this._basicClickUntilMs) return;
    this._basicClickUntilMs = now + 240;
    this.procedural.apply(ProceduralReactions.acknowledge(0.35));
  }

  onEsc(): void {
    this.cancel();
  }

  /** 切换角色 / 重载模型时调用：退出抚摸并重置互动参数。 */
  onModelReloaded(): void {
    this.petting.exitPettingMode('modelReload');
    this.petting.resetConfiguration();
    this.dragReaction.cancel();
    this.clickSequence.reset();
    this._earClickUntilMs = 0;
    this._basicClickUntilMs = 0;
    this.procedural.cancelAll(true);
  }

  /** 关闭窗口时调用：完整清理，不残留参数覆盖。 */
  onWindowClosed(): void {
    this.petting.exitPettingMode('windowClosing');
    this.procedural.cancelAll(true);
    this.clickSequence.reset();
    this._earClickUntilMs = 0;
    this._basicClickUntilMs = 0;
    this.proximity.reset();
    this.dragReaction.cancel();
  }

  /** 每帧驱动（由渲染循环调用）。 */
  tick(dtMs: number): void {
    // 一个时刻只有一个服务写互动覆盖通道。
    if (this.petting.isPettingSessionActive) {
      if (this.procedural.isPlaying) this.procedural.cancelAll(true);
      this.petting.tick(dtMs);
    } else {
      this.procedural.tick();
    }
  }
}
