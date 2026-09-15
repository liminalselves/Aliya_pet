/**
 * 渲染器自带样式：chat.css 不在渲染器职责内，这里按需注入一次，
 * 类名前缀 msk- 便于宿主覆盖。
 */

const STYLE_ID = 'msk-render-styles';

const CSS = `
.msk-segment + .msk-segment { margin-top: 6px; }
.msk-attachment { margin: 0 0 6px; }
.msk-attachment-img { display: block; max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 8px; border: 1px solid #e3dac9; background: #f2ecdd; }
.msk-sticker { display: block; height: 96px; width: auto; max-width: 100%; border-radius: 8px; }
.msk-sticker-missing { display: inline-flex; align-items: center; gap: 4px; font-size: .85em; opacity: .7; }
.msk-emoji-img { height: 96px; width: auto; max-width: 100%; vertical-align: middle; }
.msk-draw-card { position: relative; margin: 6px 0; width: min(100%, 300px); overflow: hidden; border-radius: 8px; border: 1px solid #e3dac9; background: #faf6ef; box-sizing: border-box; }
.msk-draw-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; font-weight: 700; color: #8a7a5c; border-bottom: 1px solid #efe7d8; }
.msk-draw-tag { font-weight: 400; color: #a89b85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msk-draw-body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 120px; }
.msk-draw-state { padding: 14px 10px; line-height: 1.5; text-align: center; color: #8b8172; font-size: 12px; word-break: break-word; width: 100%; box-sizing: border-box; }
.msk-draw-error { color: #b0524f; }
.msk-draw-image { display: block; width: 100%; max-height: 220px; object-fit: contain; background: #faf6ef; }
.msk-draw-foot { display: flex; gap: 6px; padding: 0 10px 10px; }
.msk-draw-btn { appearance: none; border: 1px solid #d8ccb4; border-radius: 999px; background: #fff; color: #6f5f8a; font-size: 12px; padding: 3px 10px; cursor: pointer; }
.msk-draw-btn[disabled] { opacity: .5; cursor: wait; }
.msk-draw-spinner { width: 14px; height: 14px; border: 2px solid #e3dac9; border-top-color: #6f5f8a; border-radius: 50%; animation: msk-draw-spin 1s linear infinite; }
@keyframes msk-draw-spin { to { transform: rotate(360deg); } }
.msk-link { color: #6f5f8a; text-decoration: underline; text-underline-offset: 2px; }
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
