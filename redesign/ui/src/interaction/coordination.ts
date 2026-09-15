/** 普通互动的共享规则。身体反馈与台词分开仲裁，不积压过时反应。 */
export type SpeechSource = 'ambient' | 'interaction' | 'conversation';

export class InteractionCoordinator {
  private _quietUntil = 0;

  constructor(
    private readonly state: () => { interacting: boolean; speaking: boolean; paused: boolean },
    private readonly now = () => performance.now(),
  ) {}

  /** 操作结束后留出安静间隔，避免随机动作立即接上。 */
  activity(): void {
    this._quietUntil = this.now() + 2500;
  }

  canIdle(): boolean {
    const s = this.state();
    return !s.paused && !s.interacting && !s.speaking && this.now() >= this._quietUntil;
  }

  canSpeak(source: SpeechSource): boolean {
    const s = this.state();
    if (s.paused || s.speaking) return false;
    return source !== 'ambient' || this.canIdle();
  }
}
