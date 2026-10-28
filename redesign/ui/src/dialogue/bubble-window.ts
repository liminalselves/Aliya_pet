import '../pet.css';
import { DialogueBubble } from './bubble';

interface BubblePage {
  text?: string;
  closing?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

/** 只改变独立窗口的摆放，字体、颜色、边框、尾巴和动效全部来自原 pet.css。 */
export function createBubbleRenderer(bubble: DialogueBubble) {
  const el = bubble.el;
  let text = '';
  return (page: BubblePage): { width: number; height: number; bottom: number } => {
    if (page.closing) { bubble.hidePage(); return { width: 0, height: 0, bottom: 0 }; }
    if (!page.text) { bubble.hidePage(true); text = ''; return { width: 0, height: 0, bottom: 0 }; }
    if (page.text !== text || el.style.display === 'none' || el.classList.contains('closing')) {
      bubble.showPage(page.text);
      text = page.text;
    }
    // 与人物窗口原有的小窗适配算法一致，保留原来的缩放及换行宽度。
    el.style.width = 'max-content';
    el.style.maxWidth = '260px';
    const width = el.offsetWidth || 1, height = el.offsetHeight || 1;
    const scale = Math.min(1, Math.max(0.3, Math.min(
      (page.viewportWidth ?? 300) * 0.94 / width,
      (page.viewportHeight ?? 800) * 0.62 / height,
    )));
    // 四周只保留原版弹入/淡出的位移与旋转尾巴所需空间。
    el.style.margin = '0';
    el.style.left = `${4 + width * scale / 2}px`;
    el.style.right = 'auto';
    el.style.top = '4px';
    el.style.transformOrigin = '50% 0';
    el.style.transform = `translateX(-50%) scale(${scale})`;
    return { width: Math.ceil(width * scale) + 8, height: Math.ceil((height + 8) * scale) + 8,
      bottom: 4 + height * scale };
  };
}

if (typeof document !== 'undefined') {
  document.documentElement.style.cssText = 'margin:0;background:transparent;overflow:hidden';
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
  const render = createBubbleRenderer(new DialogueBubble(document.body,
    document.getElementById('dialogue-bubble') as HTMLDivElement));
  const host = window as unknown as {
    __renderDialogueBubble: typeof render;
    BubbleHost?: { ready(): void };
  };
  host.__renderDialogueBubble = render;
  // 先加载原字体，再测量文字，避免首次显示发生字体替换与气泡尺寸跳动。
  void document.fonts.load('400 14px "Aliya Serif"').then(() => host.BubbleHost?.ready());
}
