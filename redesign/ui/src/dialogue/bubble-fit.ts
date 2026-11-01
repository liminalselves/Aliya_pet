/**
 * 台词气泡排版：字号随人物显示大小（bubbleFontFor），在此基础上按可用空间换行。
 * 气泡的内边距、圆角、尾巴都以 em 计（pet.css），整只气泡随字号等比，不用 transform。
 * 规则：
 *   1. 以 baseFont 量最宽一行的自然宽度（max-content，只在显式换行处折行）；
 *   2. 只超出一小截（≤ 35%）时，优先把字号收到刚好一行，不低于 minFont；
 *   3. 超出较多就按 baseFont 换行，只有高度实在放不下才收字号（同样不低于 minFont）。
 * 宽高由调用方用于窗口尺寸与头顶定位。
 */

export interface BubbleFitOptions {
  /** 可用宽度（窗口/视口 CSS px）。 */
  viewportWidth: number;
  /** 可用高度（窗口/视口 CSS px），只用于判断是否要收紧字号。 */
  viewportHeight?: number;
  /** 气泡自身宽度硬上限；缺省按字号取一行约 12 字。 */
  maxWidth?: number;
  /** 本次排版字号（随人物缩放，见 bubbleFontFor），默认 20。 */
  baseFont?: number;
  /** 收字号时的下限，默认 baseFont × 0.8（不低于可读下限）。 */
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
/** 可读字号下限与上限（CSS px）：人物极小/极大时气泡不至于看不清或盖满屏。 */
export const BUBBLE_FONT_MIN = 11;
export const BUBBLE_FONT_MAX = 30;
/** 人物显示为基准大小（scale=1 的外窗高 675×1.18）时的台词字号。 */
export const BUBBLE_FONT_BASE = 20;
/** 一行约容纳的字数：决定默认宽度上限（单页最多 18 字，两行放下）。 */
const CHARS_PER_LINE = 11;

/**
 * 字号随人物显示大小变化：k = 人物显示高 / 基准高。用 k^0.6 而不是线性——
 * 人物缩到 0.4 倍时字缩到约 0.58 倍，仍成比例变小但不会小到读不了；放大同理不会过大。
 */
export function bubbleFontFor(k: number): number {
  const scaled = BUBBLE_FONT_BASE * Math.pow(Math.max(0.05, k), 0.6);
  return Math.round(Math.min(BUBBLE_FONT_MAX, Math.max(BUBBLE_FONT_MIN, scaled)) * 2) / 2;
}

export function fitBubble(
  el: HTMLElement,
  options: BubbleFitOptions
): BubbleFitResult {
  const base = options.baseFont ?? BUBBLE_FONT_BASE;
  const min = Math.min(options.minFont ?? Math.max(BUBBLE_FONT_MIN, base * 0.8), base);
  const vpW = Math.max(1, options.viewportWidth);
  const cap = Math.max(
    base * 4,
    Math.min(vpW * WIDTH_RATIO, options.maxWidth ?? base * (CHARS_PER_LINE + 1.5))
  );

  // 清掉上一轮的内联适配（居中仍交给 CSS 的 left/right + margin auto）。
  el.style.transform = '';
  el.style.transformOrigin = '';
  el.style.margin = '';
  el.style.left = '';
  el.style.right = '';
  el.style.fontSize = `${base}px`;
  el.style.maxWidth = 'none';
  el.style.width = 'max-content';

  // 先量“不换行”的自然宽度：显式换行仍按行算，只把最长一行作为宽度。
  const naturalW = el.offsetWidth || 1;

  let font = base;
  let wrapped = naturalW > cap;
  // 气泡可以比人物宽：宽度上限之外还有可用空间时，先放宽到一行能放下（最多约 18 字），
  // 避免一两个字落到第二行（"…调小声 / 点。"）。
  const room = Math.min(vpW * WIDTH_RATIO, base * (CHARS_PER_LINE * 1.7));
  if (wrapped && naturalW <= room) {
    el.style.width = 'max-content';
    el.style.maxWidth = `${Math.round(room)}px`;
    const width = el.offsetWidth || naturalW;
    return { width, height: el.offsetHeight || 1, font: base, wrapped: false };
  }
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
