/**
 * GAL 逐字播放：在渲染完成的 DOM 上按文档顺序逐个字符揭示文本。
 * 图片/贴纸/代码块/表格/生图卡片等原子元素不参与逐字，播到该位置时整块淡入。
 * 隐藏期间原子元素用 visibility 保留占位，布局在播放过程中保持稳定，
 * 图片加载快慢都不会把已冒出的文字挤动（图片适配）。
 */

/** 整块揭示的元素；其内部文本不再逐字。 */
const ATOMIC_SELECTOR = 'img,table,pre,video,iframe,hr,.msk-draw-card,.msk-attachment';

type Unit = { kind: 'text'; node: Text; text: string } | { kind: 'el'; el: HTMLElement };

/** 播放间隔：短句慢一些保证可读的冒字感，长句提速避免等待。 */
export function typeDelayMs(totalChars: number): number {
  if (totalChars > 160) return 18;
  if (totalChars > 60) return 28;
  return 42;
}

export class Typewriter {
  /** 正在逐字播放；false 表示本页已全部显示。 */
  typing = false;
  /** 播放完成（含 finish 补完）回调，每页至多触发一次。 */
  onDone: (() => void) | null = null;
  /** 内容增长回调，用于让受限高度的对话框持续跟随最新文字。 */
  onProgress: (() => void) | null = null;
  private units: Unit[] = [];
  private unitIndex = 0;
  private charIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private doneFired = false;

  constructor(private readonly root: HTMLElement) {}

  /** 开始播放：收起全部文本与原子元素，然后逐个揭示。 */
  start(): void {
    this.collect();
    if (!this.units.length) { this.complete(); return; }
    this.typing = true;
    this.timer = setInterval(() => this.tick(), typeDelayMs(this.totalChars()));
  }

  /** 立即补完本页（用户点击加速）。 */
  finish(): void {
    if (!this.typing) return;
    this.stopTimer();
    for (const unit of this.units) {
      if (unit.kind === 'text') unit.node.data = unit.text;
      else this.reveal(unit.el);
    }
    this.onProgress?.();
    this.complete();
  }

  /** 停止计时器但不还原 DOM（DOM 已被外部替换时使用）。 */
  cancel(): void {
    this.stopTimer();
    this.typing = false;
  }

  private collect(): void {
    const doc = this.root.ownerDocument;
    const walker = doc.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    const atomic = new Set<HTMLElement>();
    let node = walker.nextNode();
    while (node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (parent && !parent.closest(ATOMIC_SELECTOR) && text.data !== '') {
        this.units.push({ kind: 'text', node: text, text: text.data });
        text.data = '';
      }
      node = walker.nextNode();
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(ATOMIC_SELECTOR)) {
      if (atomic.has(el)) continue;
      atomic.add(el);
      el.classList.add('tw-atomic');
      this.units.push({ kind: 'el', el });
    }
    // 原子元素按文档顺序插入对应位置
    this.units.sort((a, b) => {
      const na = a.kind === 'text' ? a.node : a.el;
      const nb = b.kind === 'text' ? b.node : b.el;
      const pos = na.compareDocumentPosition(nb);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  private tick(): void {
    const unit = this.units[this.unitIndex];
    if (!unit) { this.complete(); return; }
    if (unit.kind === 'el') {
      this.reveal(unit.el);
      this.unitIndex++;
      this.onProgress?.();
      return;
    }
    // 每次冒出一个字符（按 UTF-16 code unit 推进会把代理对劈开，按码点切）
    const next = unit.text.slice(this.charIndex, this.charIndex + 2);
    const step = next.length === 2 && /[\uD800-\uDBFF]/.test(next[0]!) ? 2 : 1;
    this.charIndex += step;
    unit.node.data = unit.text.slice(0, this.charIndex);
    this.onProgress?.();
    if (this.charIndex >= unit.text.length) { this.unitIndex++; this.charIndex = 0; }
  }

  private reveal(el: HTMLElement): void {
    el.classList.remove('tw-atomic');
    el.classList.add('tw-reveal');
  }

  private complete(): void {
    this.stopTimer();
    this.typing = false;
    if (!this.doneFired) { this.doneFired = true; this.onDone?.(); }
  }

  private stopTimer(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private totalChars(): number {
    let total = 0;
    for (const unit of this.units) if (unit.kind === 'text') total += unit.text.length;
    return total;
  }
}
