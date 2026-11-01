import '../pet.css';
import { DialogueBubble } from './bubble';
import { fitBubble } from './bubble-fit';

interface BubblePage {
  text?: string;
  closing?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  font?: number;
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
    // 与人物窗口同一套排版：字号随人物显示大小（由人物页算好传入），按可用宽度换行。
    const font = page.font ?? 20;
    const fit = fitBubble(el, {
      viewportWidth: page.viewportWidth ?? 300,
      viewportHeight: page.viewportHeight ?? 800,
      baseFont: font,
    });
    // 四周只保留弹入/淡出位移与尾巴所需空间（随字号等比）；窗口宽=气泡宽+两侧边距。
    const pad = Math.ceil(font * 0.3);
    el.style.margin = '0';
    el.style.left = `${pad}px`;
    el.style.right = 'auto';
    el.style.top = `${pad}px`;
    el.style.removeProperty('--tail-x');
    return { width: Math.ceil(fit.width) + pad * 2, height: Math.ceil(fit.height) + pad * 2,
      bottom: pad + fit.height };
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
