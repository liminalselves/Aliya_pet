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
  /** 淡出计时器：动画结束才 display:none；重新展示前必须取消。 */
  private _hideTimer: ReturnType<typeof setTimeout> | null = null;

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
    // 打断旧会话时不先隐藏：旧气泡直接换成新台词（走翻页淡入），避免「消失一帧再弹出」的闪烁。
    this._sessionToken++;
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
    this._active = false;
    this._hide(true);
  }

  /** 首次出现播放弹入（display 切换重放 CSS 动画）；已显示时只换文字并淡入，不重弹整个气泡。 */
  private _show(text: string): void {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    const visible = this._el.style.display !== 'none' && !this._el.classList.contains('closing');
    this._el.classList.remove('closing');
    this._el.textContent = text;
    if (visible) {
      this._el.classList.remove('turn');
      void this._el.offsetWidth;
      this._el.classList.add('turn');
    } else {
      this._el.classList.remove('turn');
      this._el.style.display = 'none';
      void this._el.offsetWidth;
      this._el.style.display = 'block';
    }
  }

  /** immediate=true 立即消失；否则先播 .closing 淡出再隐藏。 */
  private _hide(immediate = false): void {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (immediate || reduced || this._el.style.display === 'none') {
      this._el.classList.remove('closing');
      this._el.style.display = 'none';
      return;
    }
    this._el.classList.add('closing');
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      this._el.classList.remove('closing');
      this._el.style.display = 'none';
    }, 150);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
