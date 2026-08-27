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
  'walk',
];

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

  private _autoActionTimer: ReturnType<typeof setTimeout> | null = null;
  private _randomSpeechTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(getHost: () => PetBehaviorHost | null) {
    this._getHost = getHost;
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

  randomActionName(): string {
    return ACTION_LIBRARY[Math.floor(Math.random() * ACTION_LIBRARY.length)];
  }

  /** 播放指定动作（点击即播，动作可互相打断，不等待完成）。 */
  playAction(name: string): void {
    const host = this._getHost();
    if (!host) return;
    if (this._autoActionTimer) clearTimeout(this._autoActionTimer);
    try {
      host.playAction(name);
    } catch {
      // 动作播放失败不影响后续
    }
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
      if (this.petRunning && this.autoActions && !this.isDragging) {
        this.playAction(this.randomActionName());
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
        if (this.petRunning && this.randomSpeechEnabled && !this.isDragging) {
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
      if (!this.lookAtEnabled) host.clearLookTarget();
      return;
    }

    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const rawX = clamp01(pointerNormX);
    const x01 = this.mirrorX ? clamp01(1 - rawX) : rawX;
    // 窗口坐标向下为正，但 Live2D 视线向上为正，因此翻转 y
    const y01 = clamp01(1 - pointerNormY);
    try {
      host.setLookTarget(x01, y01);
    } catch {
      // 忽略
    }
  }

  clearLookTarget(): void {
    this._getHost()?.clearLookTarget();
  }
}
