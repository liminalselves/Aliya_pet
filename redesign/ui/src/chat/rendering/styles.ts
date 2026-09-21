/**
 * 渲染器自带样式：chat.css 不在渲染器职责内，这里按需注入一次，
 * 类名前缀 msk- 便于宿主覆盖。
 */

const STYLE_ID = 'msk-render-styles';

const CSS = `
.msk-segment + .msk-segment { margin-top: 6px; }
.msk-attachment { margin: 0 0 6px; }
.msk-attachment-img { display: block; max-width: 100%; max-height: 220px; object-fit: contain; border-radius: var(--al-r-s); border: 1px solid var(--al-line-strong); background: var(--al-bg-2); }
.msk-sticker { display: block; height: 96px; width: auto; max-width: 100%; border-radius: var(--al-r-s); }
.msk-sticker-missing { display: inline-flex; align-items: center; gap: 4px; font-size: .85em; color: var(--al-text-3); }
.msk-emoji-img { height: 96px; width: auto; max-width: 100%; vertical-align: middle; }
.msk-draw-card { position: relative; margin: 6px 0; width: min(100%, 300px); overflow: hidden; border-radius: var(--al-r-s); border: 1px solid var(--al-line-strong); background: var(--al-surface-card); box-sizing: border-box; }
.msk-draw-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; font-weight: 700; color: var(--al-accent-strong); border-bottom: 1px solid var(--al-line); }
.msk-draw-tag { font-weight: 400; color: var(--al-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msk-draw-body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 120px; }
.msk-draw-state { padding: 14px 10px; line-height: 1.5; text-align: center; color: var(--al-text-2); font-size: 12px; word-break: break-word; width: 100%; box-sizing: border-box; }
.msk-draw-error { color: var(--al-danger); }
.msk-draw-image { display: block; width: 100%; max-height: 220px; object-fit: contain; background: var(--al-bg-2); }
.msk-draw-foot { display: flex; gap: 6px; padding: 0 10px 10px; }
.msk-draw-btn { appearance: none; border: 1px solid var(--al-line-strong); border-radius: var(--al-r-pill); background: var(--al-bg-3); color: var(--al-accent-strong); font-size: 12px; padding: 3px 10px; cursor: pointer; }
.msk-draw-btn[disabled] { opacity: .5; cursor: wait; }
.msk-draw-spinner { width: 14px; height: 14px; border: 2px solid var(--al-line-strong); border-top-color: var(--al-accent); border-radius: 50%; animation: msk-draw-spin 1s linear infinite; }
@keyframes msk-draw-spin { to { transform: rotate(360deg); } }
.msk-link { color: var(--al-accent-strong); text-decoration: underline; text-underline-offset: 2px; }
img.msk-zoom { cursor: zoom-in; }
`;

/** 向文档注入渲染样式（幂等）。 */
export function ensureMskStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
