import type { ResolvedDialogue } from './dialogue';

/**
 * 台词气泡：DOM 渲染 + 会话编排（移植自 Flutter DialoguePlaybackService）。
 *   分页按时间推进（约 90ms/字），结束后保留 600~1200ms 再隐藏。
 *   会话令牌：新会话/取消时令旧会话立即失效。
 *   嘴型时间轴接入后，翻页改由时间轴驱动（TODO: mouth）。
 */
export class DialogueBubble {
  private _el: HTMLDivElement;
  private _sessionToken = 0;
  private _active = false;

  constructor(container: HTMLElement) {
    this._el = document.createElement('div');
    this._el.id = 'dialogue-bubble';
    this._el.style.display = 'none';
    container.appendChild(this._el);
  }

  get isActive(): boolean {
    return this._active;
  }

  /** 定位用（pet-app 每帧按角色头部锚定 top）。 */
  get el(): HTMLDivElement {
    return this._el;
  }

  /** 播放一次完整台词会话（覆盖进行中的会话）。 */
  async play(resolved: ResolvedDialogue): Promise<void> {
    if (resolved.pages.length === 0) return;
    this.cancel();
    const token = ++this._sessionToken;
    this._active = true;

    try {
      const startedAt = performance.now();
      // 每页时长：基础 600ms + 90ms/字（可读节奏）
      const pageDurations = resolved.pages.map(
        (p) => 600 + p.text.length * 90
      );
      const pageStarts: number[] = [];
      let acc = 0;
      for (const d of pageDurations) {
        pageStarts.push(acc);
        acc += d;
      }

      for (let i = 0; i < resolved.pages.length; i++) {
        const wait = pageStarts[i] - (performance.now() - startedAt);
        if (wait > 0) await this._sleep(wait);
        if (token !== this._sessionToken) return;
        this._show(resolved.pages[i].text);
      }

      // 最后一页同样保留完整阅读时长，再追加 600~1200ms 停顿
      await this._sleep(
        pageDurations[resolved.pages.length - 1] + 600 + Math.random() * 600
      );
      if (token !== this._sessionToken) return;
      this._hide();
    } finally {
      if (token === this._sessionToken) this._active = false;
    }
  }

  cancel(): void {
    this._sessionToken++;
    this._hide();
  }

  private _show(text: string): void {
    this._el.textContent = text;
    this._el.style.display = 'block';
  }

  private _hide(): void {
    this._el.style.display = 'none';
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
