/**
 * 人物互动统一入口：区域识别、手势识别与反应组播放集中在此（docs/INTERACTION.md）。
 * 每次互动 = 按触发键抽一个反应组（台词 + 表情 + 动作，见 reactions.ts）并同时播放；
 * 反应组没有程序微动时补一个该场景的缺省微动，保证每次点击都有即时身体反馈。
 * 上层（PetApp）转发指针输入，并实现台词、表情、Live2D 动作的呈现（ReactionHost）。
 */

import type { ResolvedDialogue } from '../dialogue/dialogue';
import { HitAreas } from './hit-areas';
import {
  PettingController,
  PettingDialogueHost,
  type PettingHapticPulse,
  type DailyInteractionPersistence,
} from './petting-controller';
import { PointerContext } from './petting-recognizer';
import {
  ClickResult,
  ClickSequenceService,
  DragReactionService,
  PointerProximityService,
  ProceduralReactionService,
  isProceduralReactionType,
  proceduralReaction,
  type ProceduralReactionType,
} from './procedural';
import type { ReactionLibrary } from './reactions';
import { InteractionTarget } from './target';

export type PetInteractionEvent =
  | { kind: 'click'; trigger: string; areaId?: string; side: number; tier?: 'repeat' | 'annoyed' | 'cooldown' }
  | { kind: 'petting'; stage: 'start' | 'soft' | 'active' | 'fast' | 'long' | 'repeat' | 'end' }
  | { kind: 'drag'; trigger: 'drag.fast' | 'drag.slow' | 'drag.shake' };

/** 上层实现的呈现能力。 */
export interface ReactionHost {
  /** 台词位是否可用（聊天占位、协调器、气泡播放中都会拒绝；urgent 允许替换现有非聊天反应气泡）。 */
  canSpeak(urgent?: boolean): boolean;
  speak(line: ResolvedDialogue, opts?: { urgent?: boolean }): void;
  /** 临时表情；有台词时持续到台词播完，之后回到当前状态的默认表情。 */
  express(name: string, line: ResolvedDialogue | null): void;
  /** 播放 Live2D 动作。 */
  playMotion(name: string): boolean;
}

/** 互动触发的 Live2D 动作在这段时间内不被下一次互动重启（连点时能演完）。 */
const MOTION_GUARD_MS = 3000;
/** 慢慢放下时说台词的概率。 */
const DRAG_SLOW_LINE_CHANCE = 0.35;

export interface ReactOptions {
  /** 反应组没有程序微动时补的缺省微动。 */
  fallback?: ProceduralReactionType;
  areaId?: string;
  side?: number;
  /** false = 只表演不说话。 */
  speak?: boolean;
  /** true = 紧急升级反应（如连点生气），可覆盖正在播放的普通反应气泡。 */
  urgent?: boolean;
  /** 尽量避开的台词 id。 */
  exclude?: Set<string>;
}

export class InteractionService {
  readonly hitAreas: HitAreas;
  readonly petting: PettingController;
  readonly clickSequence = new ClickSequenceService();
  readonly proximity = new PointerProximityService();
  readonly dragReaction = new DragReactionService();
  readonly procedural: ProceduralReactionService;
  private readonly _reactions: ReactionLibrary;
  private readonly _host: ReactionHost;
  private readonly _getTarget: () => InteractionTarget | null;
  private readonly _random: () => number;
  private readonly _onInteraction?: (event: PetInteractionEvent) => void;
  private _earClickUntilMs = 0;
  private _basicClickUntilMs = 0;
  private _motionUntilMs = 0;

  get isBusy(): boolean {
    return this.petting.isPettingSessionActive || this.procedural.isPlaying || this.dragReaction.isDragging;
  }

  /** 系统取消与失焦统一释放所有手势，取消不产生台词。 */
  cancel(): void {
    this.petting.exitPettingMode('gestureCanceled');
    this.procedural.cancelAll();
    this.dragReaction.cancel();
    this.clickSequence.reset();
    this._resetLimits();
  }

  constructor(deps: {
    hitAreas: HitAreas;
    getTarget: () => InteractionTarget | null;
    reactions: ReactionLibrary;
    host: ReactionHost;
    pettingHost: PettingDialogueHost;
    persistence?: DailyInteractionPersistence;
    onInteraction?: (event: PetInteractionEvent) => void;
    onHaptic?: (pulse: PettingHapticPulse) => void;
    random?: () => number;
  }) {
    this.hitAreas = deps.hitAreas;
    this._reactions = deps.reactions;
    this._host = deps.host;
    this._getTarget = deps.getTarget;
    this._onInteraction = deps.onInteraction;
    this._random = deps.random ?? Math.random;
    this.petting = new PettingController({
      hitAreas: deps.hitAreas,
      getTarget: deps.getTarget,
      host: deps.pettingHost,
      persistence: deps.persistence,
      onHaptic: deps.onHaptic,
      react: (trigger, exclude) => this.react(trigger, { exclude }),
    });
    this.petting.onStageEvent = (stage) => this._onInteraction?.({ kind: 'petting', stage });
    this.procedural = new ProceduralReactionService({
      getTarget: deps.getTarget,
      isPettingActive: () => this.petting.isPettingSessionActive,
      takeOverPetting: () => this.petting.releaseFinishing(),
    });
  }

  get isPettingModeActive(): boolean {
    return this.petting.isPettingModeActive;
  }

  /** 当前平滑水平速度（供手掌指针旋转，后续接光标时用）。 */
  get smoothedVelocityXPxPerSec(): number {
    return this.petting.smoothedVelocityXPxPerSec;
  }

  /**
   * 播放触发键下的一个反应组：表情、动作、台词同时开始。
   * @returns 说出的台词 id；没说话返回 null
   */
  react(trigger: string, opts: ReactOptions = {}): string | null {
    const withLine = opts.speak !== false && this._host.canSpeak(opts.urgent);
    const pick = this._reactions.pick(trigger, { withLine, excludeIds: opts.exclude });
    const group = pick?.group;
    let moved = false;
    if (group?.action && isProceduralReactionType(group.action)) {
      this.procedural.apply(proceduralReaction(group.action, {
        strength: group.strength, areaId: opts.areaId, side: opts.side,
      }));
      moved = true;
    } else if (group?.action) {
      this._playMotion(group.action);
    }
    if (!moved && opts.fallback) {
      this.procedural.apply(proceduralReaction(opts.fallback, { areaId: opts.areaId, side: opts.side }));
    }
    if (group?.expression) this._host.express(group.expression, pick?.line ?? null);
    if (!pick?.line) return null;
    this._host.speak(pick.line, opts.urgent ? { urgent: true } : undefined);
    return pick.line.entryId;
  }

  /** 指针移动。返回 true=互动已接管（上层不移动窗口/不处理拖动）。 */
  onPointerMove(ctx: PointerContext): boolean {
    this.proximity.update(ctx);
    return this.petting.onPointerMove(ctx);
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
    return this.petting.onPointerUp(ctx);
  }

  /**
   * 普通单击（非抚摸接管，上层在单击确认后调用）。
   * 返回 true 表示点击已由互动处理。
   */
  onClick(
    ctx: PointerContext,
    wasDrag: boolean,
    opts?: { pinballLaunch?: boolean; suppressSpeak?: boolean }
  ): boolean {
    if (wasDrag) {
      const wasDragging = this.dragReaction.isDragging;
      const hadShake = this.dragReaction.hadShake || this.procedural.isHoldDizzyActive;
      const fastDrag = this.dragReaction.endDrag();
      if (hadShake) {
        // 本轮已触发过摇晃转晕：松手只做落地回中，不再用 drag.fast/drag.slow 覆盖流泪表情与转晕摇晃。
        if (wasDragging && this.procedural.isHolding) {
          this.procedural.releaseHoldAfterShake?.();
        }
      } else if (fastDrag) {
        this.react('drag.fast', { fallback: 'eyes_widen' });
        this._onInteraction?.({ kind: 'drag', trigger: 'drag.fast' });
      } else if (wasDragging && this.procedural.isHolding) {
        if (opts?.pinballLaunch) {
          // 弹球模式慢速起飞（140~160 px/s）：只平滑收回拎起姿态，不叠落地蹲顿与着陆台词。
          this.procedural.releaseHoldSmooth?.();
        } else {
          // 慢慢放下：落地轻顿一下，从拎起姿态平滑回中。
          this.react('drag.slow', { fallback: 'landing', speak: this._random() < DRAG_SLOW_LINE_CHANCE });
          this._onInteraction?.({ kind: 'drag', trigger: 'drag.slow' });
        }
      }
      return false;
    }

    const speak = opts?.suppressSpeak ? false : undefined;
    this.dragReaction.cancel();
    const area = this.hitAreas.hitAreaAt(ctx.normX, ctx.normY);
    // 模型空间水平朝向：触点在角色哪一侧（镜像已还原），供蹭手、回头等朝向反应。
    const side = ((this.hitAreas.mirrored ? 1 - ctx.normX : ctx.normX) >= 0.5) ? 1 : -1;
    const areaId = area ?? undefined;

    // 耳朵不计入连点递进，但保留其历史与全局冷却。
    if (area === 'ear_left' || area === 'ear_right') {
      const now = performance.now();
      if (this.clickSequence.isInCooldown) {
        this._acknowledgeCooldownClick();
        this._onInteraction?.({ kind: 'click', trigger: 'click.cooldown', areaId, side, tier: 'cooldown' });
        return true;
      }
      if (now < this._earClickUntilMs) return true;
      // 左右耳共用一次反馈时窗，避免连点反复启动单眼眨。
      this._earClickUntilMs = now + 420;
      const trigger = `click.${area}`;
      this.react(trigger, { fallback: 'ear_blink', areaId, side, speak });
      this._onInteraction?.({ kind: 'click', trigger, areaId, side });
      return true;
    }

    const streakKey = area === 'head_pet_zone' ? 'head' : (area ?? 'body');
    const result = this.clickSequence.registerClick(streakKey);
    if (result === ClickResult.cooldown) {
      this._acknowledgeCooldownClick();
      this._onInteraction?.({ kind: 'click', trigger: 'click.cooldown', areaId, side, tier: 'cooldown' });
      return true; // 冷却只抑制台词与动作，不吞掉基础视觉反馈。
    }

    const key = `click.${streakKey}`;
    const base = this._reactions.has(key) ? key : 'click.body';
    // 连点递进：同部位 3 秒 3 次 → repeat，4 秒 5 次 → annoyed；区域没有专属组时用通用组。
    const tier = result === ClickResult.doubt ? 'repeat' : result === ClickResult.comment ? 'annoyed' : null;
    const trigger = !tier ? base
      : this._reactions.has(`${key}.${tier}`) ? `${key}.${tier}` : `click.${tier}`;
    this._triggerAreaImpulse(streakKey, side);
    this.react(trigger, { fallback: 'acknowledge', areaId, side, urgent: tier === 'annoyed', speak });
    this._onInteraction?.({ kind: 'click', trigger, areaId, side, tier: tier ?? undefined });
    return true;
  }

  /** 对被点击部位施加一次局部阻尼弹簧脉冲，使领带/刘海/侧发/马尾/双手链有即时物理回弹。 */
  private _triggerAreaImpulse(area: string, side: number): void {
    const target = this._getTarget();
    const trigger = target?.triggerPartImpulse;
    if (!trigger) return;
    switch (area) {
      case 'tie':
        trigger.call(target, 'tie', side * 0.7);
        break;
      case 'bangs':
        trigger.call(target, 'bangs', side * 0.65);
        break;
      case 'crown':
      case 'head':
        trigger.call(target, 'hair_bounce', -0.5);
        trigger.call(target, 'bangs', side * 0.25);
        break;
      case 'side_hair_left':
        trigger.call(target, 'side_hair_left', -0.9);
        break;
      case 'side_hair_right':
        trigger.call(target, 'side_hair_right', 0.9);
        break;
      case 'ponytail':
      case 'ponytail_upper':
        trigger.call(target, 'ponytail', side * 0.9);
        break;
      case 'hand':
        trigger.call(target, 'hand_right', -0.85);
        break;
      case 'tablet':
        trigger.call(target, 'hand_left', 0.85);
        break;
      case 'shoulder_left':
        trigger.call(target, 'hand_right', -0.45);
        break;
      case 'shoulder_right':
        trigger.call(target, 'hand_left', 0.45);
        break;
    }
  }

  /** 拖动中快速往返摇晃：保持拎起姿态，切换流泪表情、触发被转晕摇晃动作与台词。 */
  onDragShake(): void {
    if (!this.dragReaction.isDragging || !this.procedural.isHolding) return;
    const withLine = this._host.canSpeak(true);
    const pick = this._reactions.pick('drag.fast', { withLine });
    this._host.express('sad', pick?.line ?? null);
    this.procedural.triggerHoldDizzy?.();
    if (pick?.line) this._host.speak(pick.line, { urgent: true });
    this._onInteraction?.({ kind: 'drag', trigger: 'drag.shake' });
  }

  /** 拖动开始：进入「被拎起」姿态。 */
  beginHold(): void {
    this.procedural.hold();
  }

  /** 拖动中按画面水平/垂直速度做惯性摆头与俯仰；mirrored 时水平速度换算到模型空间。 */
  updateHoldVelocity(screenVxPxPerSec: number, screenVyPxPerSec = 0): void {
    this.procedural.setHoldSway(
      this.hitAreas.mirrored ? -screenVxPxPerSec : screenVxPxPerSec,
      screenVyPxPerSec
    );
  }

  /** 互动动作在保护期内不重启；可以打断待机或聊天动作（触碰优先）。 */
  private _playMotion(name: string): void {
    const now = performance.now();
    if (now < this._motionUntilMs) return;
    if (this._host.playMotion(name)) this._motionUntilMs = now + MOTION_GUARD_MS;
  }

  /** 冷却期间只允许低幅度点头；限频不延长台词冷却，也不触发角色动作。 */
  private _acknowledgeCooldownClick(): void {
    const now = performance.now();
    if (now < this._basicClickUntilMs) return;
    this._basicClickUntilMs = now + 240;
    this.procedural.apply(proceduralReaction('acknowledge', { strength: 0.35 }));
  }

  private _resetLimits(): void {
    this._earClickUntilMs = 0;
    this._basicClickUntilMs = 0;
    this._motionUntilMs = 0;
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
    this._resetLimits();
    this.procedural.cancelAll(true);
  }

  /** 关闭窗口时调用：完整清理，不残留参数覆盖。 */
  onWindowClosed(): void {
    this.petting.exitPettingMode('windowClosing');
    this.procedural.cancelAll(true);
    this.clickSequence.reset();
    this._resetLimits();
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
