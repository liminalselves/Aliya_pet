/**
 * 更新说明的最小 markdown 渲染（服务端 notes 字段）。
 *
 * 安全策略：先整体 HTML 转义再做受支持的标记替换，不输出原始链接/图片/HTML；
 * 支持范围 = 标题（#/##/###）、无序列表（- / *）、段落、加粗（**bold**）、
 * 行内代码（`code`）。与 CHANGELOG 的实际写法对齐，够用即可。
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行内标记（在已转义文本上替换；标记本身不含可被转义的字符）。 */
function renderInline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

export function renderUpdateNotes(markdown: string): string {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let listOpen = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length + 2; // # → h3，## → h4，### → h5
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${renderInline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }
    closeList();
    paragraph.push(escapeHtml(line));
  }
  flushParagraph();
  closeList();
  return out.join('');
}
