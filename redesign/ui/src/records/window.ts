import { openUrl, platform } from '../platform';
import { MSK_TOKEN_KEY, MSK_USER_KEY, mskSessionKey } from '../chat/msk/config';
import { CONTROL_REQUEST_KEY, readControlRequest } from '../chat/msk/control-bridge';
import { ALIYA_CHARACTER_ID, MskClient, type MskSession, type MskTimelineMessage } from '../chat/msk/client';
import { buildStickerResolver, fetchCustomEmojis, normalizeCharacterStickers } from '../chat/rendering/emoji';
import { MskMessageRenderer, type MskRendered } from '../chat/rendering/renderer';
import { normalizeRegexRules } from '../chat/rendering/rules';
import type { MskApiCaller } from '../chat/rendering/types';
import './records.css';

const HISTORY_FETCH_LIMIT = 100;
const HISTORY_ROUND_LIMIT = 50;

interface SavedContext {
  token: string;
  userId: string;
  session: Pick<MskSession, 'id' | 'name' | 'characterId' | 'characterName'> | null;
}

function lastRoundsStart(messages: MskTimelineMessage[], rounds: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      seen++;
      if (seen === rounds) return i;
    }
  }
  return 0;
}

function savedContext(): SavedContext {
  try {
    const token = localStorage.getItem(MSK_TOKEN_KEY) ?? '';
    const user = JSON.parse(localStorage.getItem(MSK_USER_KEY) ?? 'null') as { id?: unknown } | null;
    const userId = typeof user?.id === 'string' ? user.id : '';
    const raw = userId ? JSON.parse(localStorage.getItem(mskSessionKey(userId)) ?? 'null') as Record<string, unknown> | null : null;
    const id = typeof raw?.id === 'string' ? raw.id : '';
    return {
      token,
      userId,
      session: id ? {
        id,
        name: typeof raw?.name === 'string' ? raw.name : 'Aliya',
        characterId: typeof raw?.characterId === 'string' ? raw.characterId : ALIYA_CHARACTER_ID,
        characterName: typeof raw?.characterName === 'string' ? raw.characterName : 'Aliya',
      } : null,
    };
  } catch {
    return { token: '', userId: '', session: null };
  }
}

class RecordsView {
  private readonly app = document.getElementById('app')!;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private operation: AbortController | null = null;
  private renderer: MskMessageRenderer | null = null;
  private rendered: MskRendered[] = [];
  private contextKey = '';
  private loading = false;

  constructor() {
    this.app.innerHTML = `<main class="records-shell">
      <header class="records-header">
        <div class="records-heading"><span class="records-kicker">ALIYA ARCHIVE</span><h1>聊天记录</h1><p class="records-title"></p></div>
        <div class="records-actions"><span class="records-meta"></span><button type="button" class="records-refresh">刷新</button></div>
      </header>
      <div class="records-status" role="status" aria-live="polite"></div>
      <section class="records-list" aria-label="聊天记录"></section>
    </main>`;
    this.title = this.app.querySelector('.records-title')!;
    this.meta = this.app.querySelector('.records-meta')!;
    this.refreshButton = this.app.querySelector('.records-refresh')!;
    this.list = this.app.querySelector('.records-list')!;
    this.status = this.app.querySelector('.records-status')!;
    this.refreshButton.onclick = () => { void this.load(true); };
    window.addEventListener('focus', () => { void this.load(true); });
    window.addEventListener('storage', event => {
      if ([MSK_TOKEN_KEY, MSK_USER_KEY, CONTROL_REQUEST_KEY].includes(event.key ?? '') || event.key?.startsWith('aliya_session:')) {
        void this.load(true);
      }
    });
  }

  async load(force: boolean): Promise<void> {
    const saved = savedContext();
    const request = readControlRequest(localStorage);
    const navigate = request?.action === 'navigate' && request.sessionId === saved.session?.id ? request : null;
    const nextKey = `${saved.userId}:${saved.session?.id ?? ''}:${navigate?.at ?? ''}`;
    if (!force && nextKey === this.contextKey && !navigate) return;
    this.contextKey = nextKey;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.clearRendering();
    this.renderer = null;
    this.loading = true;
    this.refreshButton.disabled = true;
    this.status.textContent = '';
    this.list.replaceChildren();

    try {
      if (!saved.token) {
        this.showEmpty('尚未连接 Misskey', '请先在聊天窗口完成授权。');
        return;
      }
      if (!saved.session) {
        this.showEmpty('尚未选择会话', '回到聊天窗口选择一个会话后，这里会显示记录。');
        return;
      }
      this.title.textContent = saved.session.name || saved.session.characterName || 'Aliya';
      this.meta.textContent = navigate ? '上下文定位' : '最近 50 轮';
      this.status.textContent = navigate ? '正在定位消息……' : '正在读取记录……';
      const client = new MskClient(saved.token);
      const api: MskApiCaller = (endpoint, body, signal) => client.post('/' + endpoint, body, signal);
      const detail = await api<{ characterStickers?: unknown; characterId?: string }>('agents/sessions/show', { sessionId: saved.session.id }, operation.signal);
      const character = await api<{ regexRules?: unknown }>('agents/characters/show', {
        characterId: detail.characterId || saved.session.characterId || ALIYA_CHARACTER_ID,
      }, operation.signal).catch(() => ({ regexRules: [] as unknown[] }));
      if (operation.signal.aborted) return;
      this.renderer = new MskMessageRenderer({
        api,
        openUrl: url => { void openUrl(url); },
        onImageClick: url => { void openUrl(url); },
        regexRules: normalizeRegexRules(character.regexRules),
        resolveSticker: buildStickerResolver(normalizeCharacterStickers(detail.characterStickers)),
        loadEmojis: signal => fetchCustomEmojis(api, signal),
        autoDraw: false,
      });
      if (navigate) {
        const messages = await client.messagesAround(saved.session.id, navigate.messageId!, operation.signal);
        if (operation.signal.aborted) return;
        this.renderMessages(saved.session.id, messages, navigate.messageId, navigate.divider);
        if (readControlRequest(localStorage)?.at === navigate.at) localStorage.removeItem(CONTROL_REQUEST_KEY);
      } else {
        const messages = await client.timeline(saved.session.id, HISTORY_FETCH_LIMIT, operation.signal);
        if (operation.signal.aborted) return;
        this.renderLatest(saved.session.id, messages);
      }
      this.status.textContent = '';
    } catch (error) {
      if (!operation.signal.aborted) this.showEmpty('记录读取失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      if (this.operation === operation) {
        this.loading = false;
        this.refreshButton.disabled = false;
      }
    }
  }

  private renderLatest(sessionId: string, messages: MskTimelineMessage[]): void {
    if (!messages.length) {
      this.showEmpty('还没有聊天记录', '在聊天窗口和 Aliya 说点什么吧。');
      return;
    }
    const start = lastRoundsStart(messages, HISTORY_ROUND_LIMIT);
    if (start > 0 || messages.length >= HISTORY_FETCH_LIMIT) {
      const note = document.createElement('div');
      note.className = 'records-truncated';
      note.textContent = `更早的对话已省略，aliya_pet 仅支持显示 ${HISTORY_ROUND_LIMIT} 轮对话`;
      this.list.append(note);
    }
    this.renderMessages(sessionId, messages.slice(start));
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  private renderMessages(sessionId: string, messages: MskTimelineMessage[], targetId?: string, divider?: boolean): void {
    let target: HTMLElement | null = null;
    for (const message of messages) {
      if (message.role === 'system' && message.id !== targetId) continue;
      const article = document.createElement('article');
      article.className = `record-message record-${message.role}`;
      const head = document.createElement('header');
      const author = document.createElement('strong');
      author.textContent = message.role === 'system' ? '上下文分界' : message.role === 'user' ? '你' : 'Aliya';
      const time = document.createElement('time');
      if (message.createdAt) {
        const date = new Date(message.createdAt);
        if (!Number.isNaN(date.getTime())) {
          time.dateTime = message.createdAt;
          time.textContent = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      }
      head.append(author, time);
      const body = document.createElement('div');
      body.className = 'message-text';
      article.append(head, body);
      this.list.append(article);
      if (message.role === 'system') body.textContent = divider ? '从这里开始新的上下文' : message.content || '上下文分界';
      else this.bindMessage(sessionId, message, body);
      if (message.id === targetId) {
        target = article;
        article.classList.add('record-target');
        article.tabIndex = -1;
      }
    }
    if (target) requestAnimationFrame(() => {
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
    });
    else if (targetId) this.status.textContent = '目标消息已删除或不在可见记录中。';
  }

  private bindMessage(sessionId: string, message: MskTimelineMessage, container: HTMLElement): void {
    if (!this.renderer || message.role === 'system') return;
    const task = this.renderer.render({
      sessionId,
      messageId: message.id,
      text: message.content,
      role: message.role,
      file: message.file,
      liveArrived: false,
    });
    task.bind(container);
    this.rendered.push(task);
  }

  private showEmpty(title: string, detail: string): void {
    this.list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'records-empty';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    empty.append(heading, paragraph);
    this.list.append(empty);
    this.status.textContent = '';
  }

  private clearRendering(): void {
    for (const task of this.rendered) task.cancel();
    this.rendered = [];
  }
}

const view = new RecordsView();
if (platform === 'tauri') {
  const { listen } = await import('@tauri-apps/api/event');
  await listen('records-open', () => { void view.load(true); });
} else {
  void view.load(true);
}
