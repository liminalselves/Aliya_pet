/**
 * 角色行为服务（移植自 Flutter CharacterBehaviorService，逻辑等价）：
 *   - 自动随机动作：8~16 秒间隔，从动作库随机抽取
 *   - 随机台词：默认关闭，间隔可配（分钟）
 *   - 视线跟随：指针归一化坐标 → Live2D 注视目标（y 轴翻转：窗口向下为正，视线向上为正）
 * 与渲染框架解耦，通过 PetBehaviorHost 访问模型能力。
 */

export interface PetBehaviorHost {
  /** 播放语义动作名（nod/sway/...）；动作不存在返回 false。 */
  playAction(name: string): boolean;
  readonly isActionPlaying?: boolean;
  /** 设置注视目标（0..1，y 向上为正）。 */
  setLookTarget(x01: number, y01: number): void;
  clearLookTarget(): void;
}

/** 随机动作库（业务语义名 → model3.json 动作组名，一一对应）。 */
export const ACTION_LIBRARY = [
  'nod',
  'sway',
  'shake',
  'stretch',
  'wave',
  'doubt',
  'angry',
  'yawn',
  'cheerful_bounce',
  'shy_sway',
  'look_around',
  'daydream',
  'notice',
];

/**
 * 视线跟随释放策略：指针静止 GAZE_RELEASE_SECONDS 后不再盯住光标，
 * 眼睛回到动作/待机控制，自动动作优先抽 category=gaze 的张望/发呆；
 * 静止超过 NOTICE_AFTER_SECONDS 后指针再动，先播一下 notice（回神）再恢复跟随。
 */
export const GAZE_RELEASE_SECONDS = 5;
export const NOTICE_AFTER_SECONDS = 12;
const NOTICE_COOLDOWN_SECONDS = 30;
/** 指针归一化坐标的移动阈值（滤掉逐帧重复上报与亚像素抖动）。 */
const POINTER_MOVE_EPSILON = 0.005;
/** 视线释放期间自动动作改抽视线类演出的概率。 */
const GAZE_IDLE_CHANCE = 0.65;

/** 动作清单元数据条目（pet-model 从 actions.json 载入后注入）。 */
export interface ActionMeta {
  name: string;
  /** gaze=只在视线释放后自动播放；reaction=只由事件触发，不参与随机。 */
  category?: 'idle' | 'emotion' | 'reaction' | 'gaze';
  weight?: number;
  moods?: Record<string, number>;
}

const AUTO_ACTION_MIN_SECONDS = 8;
const AUTO_ACTION_MAX_SECONDS = 16;

export class BehaviorService {
  private readonly _getHost: () => PetBehaviorHost | null;

  /** 视线跟随开关。 */
  lookAtEnabled = true;
  /** 渲染镜像时，视线输入也要水平翻转。 */
  mirrorX = false;
  /** 自动随机动作开关。 */
  autoActions = true;
  /** 随机台词开关。 */
  randomSpeechEnabled = false;
  /** 随机台词间隔（分钟）。 */
  randomSpeechIntervalMinutes = 5;
  /** 是否正在拖动（拖动期间不触发自动动作与视线跟随）。 */
  isDragging = false;
  /** 宠物是否运行。 */
  petRunning = true;

  /** 随机台词触发回调（上层播放一条随机台词）。 */
  onRandomSpeech: (() => void) | null = null;
  /** 共用调度入口：互动、说话、暂停和操作后的安静间隔。 */
  canIdle: () => boolean = () => true;

  /** 动作元数据（actions.json；注入后自动动作按 权重×情绪亲和 抽取）。 */
  private _actionMeta: ActionMeta[] | null = null;
  /** 当前情绪名（用于亲和加权；null = neutral）。 */
  private _mood: string | null = null;

  private _autoActionTimer: ReturnType<typeof setTimeout> | null = null;
  private _randomSpeechTimer: ReturnType<typeof setTimeout> | null = null;

  // 视线释放状态（指针静止检测）
  private readonly _now: () => number;
  private _lastPointerX = Number.NaN;
  private _lastPointerY = Number.NaN;
  private _lastPointerMoveMs: number;
  private _gazeReleased = false;
  private _lastNoticeMs = -Infinity;
  /** 当前（最近一次）动作是否是自动抽出的视线类演出。 */
  private _lastAutoWasGaze = false;

  constructor(getHost: () => PetBehaviorHost | null, now: () => number = () => performance.now()) {
    this._getHost = getHost;
    this._now = now;
    this._lastPointerMoveMs = now();
  }

  /** 指针静止已释放视线跟随（角色自己看别处）。 */
  get gazeReleased(): boolean {
    return this._gazeReleased;
  }

  /** 注入动作元数据清单（模型加载完成后调用）。 */
  setActionMeta(meta: ActionMeta[] | null): void {
    this._actionMeta = meta;
  }

  /** 同步当前情绪（情绪引擎每次变化时调用）。 */
  setMood(name: string): void {
    this._mood = name;
  }

  start(): void {
    this.petRunning = true;
    this._scheduleNextAutoAction();
    this._scheduleNextRandomSpeech();
  }

  stop(): void {
    this.petRunning = false;
    if (this._autoActionTimer) clearTimeout(this._autoActionTimer);
    if (this._randomSpeechTimer) clearTimeout(this._randomSpeechTimer);
    this._autoActionTimer = null;
    this._randomSpeechTimer = null;
  }

  // ---------- 动作调度 ----------

  /**
   * 按权重抽取动作：基础权重（actions.json，缺省 1）× 当前情绪亲和倍率。
   * 无元数据时退化为均匀抽取。
   */
  randomActionName(): string {
    const meta = this._actionMeta;
    if (!meta || meta.length === 0) {
      return ACTION_LIBRARY[Math.floor(Math.random() * ACTION_LIBRARY.length)];
    }
    const mood = this._mood ?? 'neutral';
    // 视线类演出只在视线释放后出现（盯着光标时张望会被跟随覆盖，显得穿帮）；
    // reaction 只由事件触发。释放期间按概率优先抽视线类。
    const wantGaze = this._gazeReleased && Math.random() < GAZE_IDLE_CHANCE;
    const pool = meta.filter((m) => ACTION_LIBRARY.includes(m.name) && m.category !== 'reaction');
    const gazePool = pool.filter((m) => m.category === 'gaze');
    const entries = wantGaze && gazePool.length > 0
      ? gazePool
      : pool.filter((m) => m.category !== 'gaze');
    const weights = entries.map((m) => {
      const base = typeof m.weight === 'number' && m.weight > 0 ? m.weight : 1;
      const affinity = m.moods?.[mood] ?? 1;
      return base * affinity;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return ACTION_LIBRARY[0];
    let roll = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return entries[i].name;
    }
    return entries[entries.length - 1].name;
  }

  /** 播放指定动作（点击即播，动作可互相打断，不等待完成）。 */
  playAction(name: string): void {
    const host = this._getHost();
    if (!host) return;
    this._lastAutoWasGaze = false;
    if (this._autoActionTimer) clearTimeout(this._autoActionTimer);
    try {
      host.playAction(name);
    } catch {
      // 动作播放失败不影响后续
    }
    this._scheduleNextAutoAction();
  }

  /**
   * 手动播过动作后仅重排自动动作定时器（不重播）。
   * 供 petAI.play 等已直接调用模型播放的入口使用，避免二次播放。
   */
  notifyManualAction(): void {
    this._lastAutoWasGaze = false;
    this._scheduleNextAutoAction();
  }

  private _scheduleNextAutoAction(): void {
    if (this._autoActionTimer) clearTimeout(this._autoActionTimer);
    this._autoActionTimer = null;
    if (!this.petRunning || !this.autoActions) return;
    const seconds =
      Math.floor(
        Math.random() * (AUTO_ACTION_MAX_SECONDS - AUTO_ACTION_MIN_SECONDS + 1)
      ) + AUTO_ACTION_MIN_SECONDS;
    this._autoActionTimer = setTimeout(() => {
      this._checkGazeRelease();
      if (this.petRunning && this.autoActions && !this.isDragging && this.canIdle() && !this._getHost()?.isActionPlaying) {
        const name = this.randomActionName();
        this.playAction(name);
        this._lastAutoWasGaze = this._actionMeta?.find((m) => m.name === name)?.category === 'gaze';
      }
      this._scheduleNextAutoAction();
    }, seconds * 1000);
  }

  private _scheduleNextRandomSpeech(): void {
    if (this._randomSpeechTimer) clearTimeout(this._randomSpeechTimer);
    this._randomSpeechTimer = null;
    if (!this.petRunning || !this.randomSpeechEnabled) return;
    this._randomSpeechTimer = setTimeout(
      () => {
        if (this.petRunning && this.randomSpeechEnabled && !this.isDragging && this.canIdle()) {
          this.onRandomSpeech?.();
        }
        this._scheduleNextRandomSpeech();
      },
      this.randomSpeechIntervalMinutes * 60 * 1000
    );
  }

  /** 开关变更后重排随机台词定时器。 */
  refreshRandomSpeech(): void {
    this._scheduleNextRandomSpeech();
  }

  // ---------- 视线跟随 ----------

  /**
   * 更新视线目标（指针移动时调用）。
   * @param pointerNormX 指针相对角色渲染区域的归一化 X（0..1）
   * @param pointerNormY 归一化 Y（0..1，向下为正）
   */
  updateLookTarget(pointerNormX: number, pointerNormY: number): void {
    const host = this._getHost();
    if (!host) return;
    if (!this.lookAtEnabled || !this.petRunning || this.isDragging) {
      host.clearLookTarget();
      return;
    }
    if (!Number.isFinite(pointerNormX) || !Number.isFinite(pointerNormY)) return;

    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const rawX = clamp01(pointerNormX);
    const x01 = this.mirrorX ? clamp01(1 - rawX) : rawX;
    // 窗口坐标向下为正，但 Live2D 视线向上为正，因此翻转 y
    const y01 = clamp01(1 - pointerNormY);

    // 静止检测：桌面端每帧都会重复上报同一坐标，只有真正移动才刷新计时。
    const now = this._now();
    const moved = !(Math.abs(x01 - this._lastPointerX) <= POINTER_MOVE_EPSILON &&
      Math.abs(y01 - this._lastPointerY) <= POINTER_MOVE_EPSILON);
    if (moved) {
      const stillSeconds = (now - this._lastPointerMoveMs) / 1000;
      this._lastPointerX = x01;
      this._lastPointerY = y01;
      this._lastPointerMoveMs = now;
      if (this._gazeReleased) {
        this._gazeReleased = false;
        this._maybeNotice(now, stillSeconds);
      }
    } else {
      this._checkGazeRelease();
    }
    if (this._gazeReleased) return;
    try {
      host.setLookTarget(x01, y01);
    } catch {
      // 忽略
    }
  }

  clearLookTarget(): void {
    this._getHost()?.clearLookTarget();
  }

  /**
   * 光标放着不动：不再死盯，交还给动作与待机（GazeController 平滑回中）。
   * 桌面端每帧上报坐标会调用这里；触屏只在事件时上报，由自动动作定时器补查。
   */
  private _checkGazeRelease(): void {
    if (this._gazeReleased || !Number.isFinite(this._lastPointerX)) return;
    if (this._now() - this._lastPointerMoveMs < GAZE_RELEASE_SECONDS * 1000) return;
    this._gazeReleased = true;
    this._getHost()?.clearLookTarget();
  }

  /** 久静后指针再动：轻轻「回神」看过来。不抢互动、拖动和非待机演出。 */
  private _maybeNotice(now: number, stillSeconds: number): void {
    if (stillSeconds < NOTICE_AFTER_SECONDS) return;
    if (now - this._lastNoticeMs < NOTICE_COOLDOWN_SECONDS * 1000) return;
    if (!this.petRunning || !this.autoActions || this.isDragging || !this.canIdle()) return;
    if (!ACTION_LIBRARY.includes('notice')) return;
    // 只打断自己放的张望/发呆；AI、点击等其它来源的演出继续播完。
    if (this._getHost()?.isActionPlaying && !this._lastAutoWasGaze) return;
    this._lastNoticeMs = now;
    this.playAction('notice');
  }
}
