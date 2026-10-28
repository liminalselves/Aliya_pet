/**
 * 台词气泡的小窗适配：把“等比 transform 缩放整个气泡”换成“只收字号 + 按可用宽度换行”。
 *
 * 原实现按 0.3 的下限等比缩放气泡盒子，14px 的字最小会被缩到 4px：小尺寸人物
 * 时台词看不清；另外 CSS 的 82% 宽度上限与脚本量出的可用宽度口径不一致，
 * 会让“本来放得下一行”的短句提前断行。现在的规则：
 *   1. 量最宽一行的自然宽度（max-content，只在显式换行处折行）；
 *   2. 只超出一小截（≤ 35% 硬上限）时，优先把字号收到刚好一行，字号下限 12px；
 *   3. 超出较多就按原字号换行，只有高度实在放不下才收字号（同样不低于 12px）。
 * 不做 transform 缩放，宽高由调用方用于窗口尺寸与头顶定位。
 */

export interface BubbleFitOptions {
  /** 可用宽度（窗口/视口 CSS px）。 */
  viewportWidth: number;
  /** 可用高度（窗口/视口 CSS px），只用于判断是否要收紧字号。 */
  viewportHeight?: number;
  /** 气泡自身宽度硬上限（人物内嵌 300、独立气泡窗 260）。 */
  maxWidth?: number;
  /** 默认字号，默认 14。 */
  baseFont?: number;
  /** 可读字号下限，默认 12。 */
  minFont?: number;
}

export interface BubbleFitResult {
  /** 气泡布局盒宽度（未缩放，CSS px）。 */
  width: number;
  /** 气泡布局盒高度（未缩放，CSS px）。 */
  height: number;
  /** 实际使用的字号。 */
  font: number;
  /** 是否按可用宽度换行（false 表示保持自然宽度/显式换行）。 */
  wrapped: boolean;
}

/** 可用宽度占比：留出边缘余量，不贴窗口边。 */
const WIDTH_RATIO = 0.94;
/** 可用高度占比：气泡最多占窗口高度的这段，超出靠盖住头顶而不是继续缩字。 */
const HEIGHT_RATIO = 0.62;
/** 宽度余量：吸收字体度量的小数误差，避免“差 0.2px”把整句拆成两行。 */
const WIDTH_SLACK = 2;
/** 只略超宽时才考虑“缩字号保一行”，长句直接换行（否则整段会被无谓缩小）。 */
const SINGLE_LINE_RATIO = 1.35;

export function fitBubble(
  el: HTMLElement,
  options: BubbleFitOptions
): BubbleFitResult {
  const base = options.baseFont ?? 14;
  const min = Math.min(options.minFont ?? 12, base);
  const vpW = Math.max(1, options.viewportWidth);
  const cap = Math.max(
    64,
    Math.min(vpW * WIDTH_RATIO, options.maxWidth ?? 300)
  );

  // 清掉上一轮的内联适配（居中仍交给 CSS 的 left/right + margin auto）。
  el.style.transform = '';
  el.style.transformOrigin = '';
  el.style.margin = '';
  el.style.left = '';
  el.style.right = '';
  // 只在上一轮真的改过字号时才清，避免给元素留下空字符串样式键。
  if (el.style.fontSize) el.style.fontSize = '';
  el.style.maxWidth = 'none';
  el.style.width = 'max-content';

  // 先量“不换行”的自然宽度：显式换行仍按行算，只把最长一行作为宽度。
  const naturalW = el.offsetWidth || 1;

  let font = base;
  let wrapped = naturalW > cap;
  if (wrapped && naturalW <= cap * SINGLE_LINE_RATIO) {
    // 只超出一小截：优先把字号收到刚好塞进一行（不低于可读下限）。
    const fitFont = Math.floor(((cap - WIDTH_SLACK) / naturalW) * base * 2) / 2;
    if (fitFont >= min) {
      font = fitFont;
      wrapped = false;
    }
  }
  if (font !== base) el.style.fontSize = `${font}px`;

  if (wrapped) {
    el.style.width = `${Math.round(cap)}px`;
  } else {
    el.style.width = 'max-content';
    el.style.maxWidth = `${Math.round(cap)}px`;
  }
  let width = el.offsetWidth || 1;
  // 字体度量不是严格线性：按比例收到的字号偶尔仍差零点几像素而折行，这里以 0.5px
  // 步进复核到真正放得下，或撞到可读下限（此时接受换行）。
  while (!wrapped && width > cap && font > min) {
    font = Math.max(min, font - 0.5);
    el.style.fontSize = `${font}px`;
    width = el.offsetWidth || width;
    if (font === min) {
      wrapped = width > cap;
      break;
    }
  }
  let height = el.offsetHeight || 1;

  // 高度兜底：换行或显式多行后高过可用高度时，把字号收到下限再量一次；
  // 收到下限仍超出就让气泡盖住头顶（顶边由调用方钳位），不再牺牲可读性。
  const availH = (options.viewportHeight ?? 0) * HEIGHT_RATIO;
  if (availH > 0 && height > availH && font > min) {
    const fit = Math.max(min, Math.floor((font * availH) / height * 2) / 2);
    if (fit < font) {
      font = fit;
      el.style.fontSize = `${font}px`;
      height = el.offsetHeight || height;
    }
  }

  return { width, height, font, wrapped };
}
