/**
 * 网页嵌入模式（官网首页的 Aliya 舞台，构建入口 embed.html，见 docs/EMBED.md）。
 *
 * 与本体共用同一套渲染、互动、对话与情绪代码，只关掉网页上用不到的部分：
 * 聊天、窗口拖动、设置存档。资源路径统一走 assetUrl()，嵌入产物可以放在
 * 任意子目录下（官网放在 /pet/）。
 */

/** 嵌入页由 embed.html 设置 window.__ALIYA_EMBED__ = true。 */
export const isEmbed: boolean =
  typeof window !== 'undefined' && (window as unknown as { __ALIYA_EMBED__?: boolean }).__ALIYA_EMBED__ === true;

/** 资源根路径：本体为站点根 '/'；嵌入构建为 vite base（如 '/pet/'）。 */
const BASE: string = import.meta.env.BASE_URL ?? '/';

/** 把以 '/' 开头的资源路径换成相对资源根的地址。 */
export function assetUrl(path: string): string {
  return BASE + path.replace(/^\/+/, '');
}

/** 通知嵌入方（父页面）当前状态，父页面据此撤掉静态占位图。 */
export function postToHost(type: 'ready' | 'error', detail?: string): void {
  if (!isEmbed || window.parent === window) return;
  try {
    window.parent.postMessage({ source: 'aliya-pet', type, detail }, '*');
  } catch {
    // 跨源受限时忽略：父页面会在超时后自行处理
  }
}
