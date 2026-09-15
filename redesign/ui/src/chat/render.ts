/**
 * MSK 消息渲染：MFM（Misskey Flavored Markdown）+ 常用 Markdown 子集。
 * 移植自 Aliya_web/js/message-renderer.js，保持两处渲染结果一致。
 * 输出前已转义全部 HTML，可直接 innerHTML。
 *
 * 本文件是同步渲染引擎（无模块依赖，保证既有调用方与 vm 测试直接加载）。
 * 完整的 MSK 异步渲染（贴纸/全站表情/生图占位符/正则显示规则/分段/附件）
 * 见 ./rendering/renderer.ts 的 MskMessageRenderer。
 */

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function decodeBasicEntities(value: unknown): string {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeUrl(value: unknown): string {
  const raw = decodeBasicEntities(value).trim();
  return /^(https?:|mailto:|tel:)/i.test(raw) ? raw : '';
}

function isMarkdownSeparator(line: string): boolean {
  return /^\s{0,3}(?:(?:-{3,})|(?:_{3,})|(?:\*{3,}))\s*$/.test(line);
}

function isTableDelimiter(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (line.indexOf('|') !== -1 && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) return true;
  if (isListItem(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  return isMarkdownSeparator(line);
}

function splitTableRow(line: string): string[] {
  const cells = String(line || '').trim().split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

function stashToken(tokens: string[], html: string): string {
  const key = '\u0000' + tokens.length + '\u0000';
  tokens.push(html);
  return key;
}

const MFM_CLASS_MAP: Record<string, string> = {
  x2: 'mfm-x2',
  x3: 'mfm-x3',
  x4: 'mfm-x4',
  blur: 'mfm-blur',
  center: 'mfm-center',
  flip: 'mfm-flip',
  jelly: 'mfm-jelly',
  tada: 'mfm-tada',
  jump: 'mfm-jump',
  bounce: 'mfm-bounce',
  spin: 'mfm-spin',
  shake: 'mfm-shake',
  rainbow: 'mfm-rainbow',
  sparkle: 'mfm-sparkle',
};

function renderMfmFunction(name: string, opts: string | undefined, body: string): string {
  const fn = String(name || '').toLowerCase();
  const safeBody = body || '';
  if (fn === 'fg' || fn === 'bg') {
    let color = String(opts || '').replace(/^color=/, '').trim();
    if (/^#?[0-9a-fA-F]{3,8}$/.test(color)) {
      if (color.charAt(0) !== '#') color = '#' + color;
    } else if (!/^[a-zA-Z]+$/.test(color)) {
      return safeBody;
    }
    const prop = fn === 'fg' ? 'color' : 'background-color';
    return `<span class="mfm ${fn === 'fg' ? 'mfm-fg' : 'mfm-bg'}" style="${prop}:${escapeAttr(color)}">${safeBody}</span>`;
  }
  const cls = MFM_CLASS_MAP[fn];
  if (!cls) return safeBody;
  return `<span class="mfm ${cls}">${safeBody}</span>`;
}

function renderMfmFunctions(html: string): string {
  let previous = '';
  let output = html;
  let guard = 0;
  while (previous !== output && guard < 8) {
    previous = output;
    output = output.replace(/\$\[([A-Za-z0-9_]+)(?:\.([^\s\]]+))?\s+([^\[\]]*?)\]/g,
      (_, name, opts, body) => renderMfmFunction(name, opts, body));
    guard++;
  }
  return output;
}

export function renderInline(source: string): string {
  const tokens: string[] = [];
  let html = escapeHtml(source);

  html = html.replace(/`([^`\n]+)`/g, (_, code) => stashToken(tokens, `<code>${code}</code>`));

  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = safeUrl(href);
    if (!url) return label;
    return stashToken(tokens, `<a class="msk-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${renderInline(decodeBasicEntities(label))}</a>`);
  });

  html = html.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (_, prefix, url) => {
    const cleaned = String(url).replace(/[),，。！？!?]+$/, '');
    const tail = String(url).slice(cleaned.length);
    const decodedUrl = decodeBasicEntities(cleaned);
    return prefix + stashToken(tokens, `<a class="msk-link" href="${escapeAttr(decodedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(decodedUrl)}</a>`) + escapeHtml(decodeBasicEntities(tail));
  });

  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  html = renderMfmFunctions(html);

  html = html
    .replace(/(^|[\s(])@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g, '$1<span class="mfm-mention">@$2</span>')
    .replace(/(^|[\s(])#([^\s#.,!?，。！？、]+)/g, '$1<span class="mfm-hashtag">#$2</span>')
    .replace(/:([A-Za-z0-9_+-]{2,}):/g, '<span class="mfm-emoji">:$1:</span>');

  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}

function renderCodeBlock(lines: string[], info: string): string {
  const lang = String(info || '').trim().split(/\s+/)[0];
  const className = /^[A-Za-z0-9_-]+$/.test(lang) ? ` class="language-${escapeAttr(lang)}"` : '';
  return `<pre><code${className}>${escapeHtml(lines.join('\n'))}</code></pre>`;
}

function renderTable(lines: string[]): string {
  const headers = splitTableRow(lines[0]);
  const html = ['<div class="message-table-wrap"><table><thead><tr>'];
  for (const cell of headers) html.push(`<th>${renderInline(cell.trim())}</th>`);
  html.push('</tr></thead><tbody>');
  for (let i = 2; i < lines.length; i++) {
    html.push('<tr>');
    for (const cell of splitTableRow(lines[i])) html.push(`<td>${renderInline(cell.trim())}</td>`);
    html.push('</tr>');
  }
  html.push('</tbody></table></div>');
  return html.join('');
}

function renderList(lines: string[]): string {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[0]);
  const tag = ordered ? 'ol' : 'ul';
  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.*)$/);
    if (match) {
      if (current) items.push(current);
      current = [match[1]];
    } else if (current) {
      current.push(line.replace(/^\s{2,}/, ''));
    }
  }
  if (current) items.push(current);
  return `<${tag}>${items.map(itemLines =>
    `<li>${itemLines.map(renderInline).join('<br>')}</li>`).join('')}</${tag}>`;
}

export function renderMarkdown(source: unknown): string {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fenceStart = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceStart) {
      const fenceChar = fenceStart[1].charAt(0);
      const fenceEndRegex = new RegExp('^\\s*' + fenceChar + '{' + fenceStart[1].length + ',}\\s*$');
      const codeLines: string[] = [];
      const info = fenceStart[2] || '';
      i++;
      while (i < lines.length && !fenceEndRegex.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      html.push(renderCodeBlock(codeLines, info));
      continue;
    }

    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) tableLines.push(lines[i++]);
      html.push(renderTable(tableLines));
      continue;
    }

    if (isMarkdownSeparator(line)) { html.push('<hr>'); i++; continue; }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    if (isListItem(line)) {
      const listLines = [line];
      i++;
      while (i < lines.length && (isListItem(lines[i]) || /^\s{2,}\S/.test(lines[i]))) listLines.push(lines[i++]);
      html.push(renderList(listLines));
      continue;
    }

    const paragraphLines = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines, i)) paragraphLines.push(lines[i++]);
    html.push(`<p>${paragraphLines.map(renderInline).join('<br>')}</p>`);
  }

  return html.join('');
}

/** 渲染进容器（innerHTML 替换）。 */
export function renderInto(container: HTMLElement, source: string): void {
  container.innerHTML = renderMarkdown(source);
}
