/** 只同步独立气泡的文字与锚点；原有 DOM/CSS 在气泡窗口中直接复用。 */
export class AndroidDialogueBubble {
  private _key = '';
  private _text = '';
  private _sentAt = -Infinity;
  private _closing = false;

  constructor(private readonly _send: (json: string) => void) {}

  /** font：随人物显示大小的台词字号（bubbleFontFor），气泡窗按它排版并整体等比。 */
  sync(text: string, centerX: number, headY: number, viewportWidth: number, viewportHeight: number, font = 20): void {
    if (!text) { this.hide(); return; }
    const textChanged = text !== this._text || this._closing;
    const json = JSON.stringify({ text, centerX: Math.round(centerX), headY: Math.round(headY),
      viewportWidth: Math.round(viewportWidth), viewportHeight: Math.round(viewportHeight), font });
    if (json === this._key && !this._closing) return;
    const now = performance.now();
    // 动作头顶跟随约 8Hz；文字翻页/重现立即发送。拖动与归位由原生跟随，不经 JS。
    if (!textChanged && now - this._sentAt < 120) return;
    this._send(json);
    this._key = json;
    this._text = text;
    this._sentAt = now;
    this._closing = false;
  }

  close(): void {
    if (!this._key || this._closing) return;
    this._send('{"closing":true}');
    this._closing = true;
  }

  hide(): void {
    if (!this._key) return;
    this._send('{"text":""}');
    this._key = '';
    this._text = '';
    this._sentAt = -Infinity;
    this._closing = false;
  }
}
