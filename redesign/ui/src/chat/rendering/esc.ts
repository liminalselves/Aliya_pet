/**
 * 结构化 HTML（贴纸图、生图卡片、附件图等）的安全转义工具。
 * 文本正文的转义由 ../render 的先转义管线负责，这里只服务渲染器自行拼接的标签。
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

/** 结构化标签只接受 http/https 图片地址；其余一律丢弃。 */
export function safeHttpUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}
