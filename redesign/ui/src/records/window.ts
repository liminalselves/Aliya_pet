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
/** 距底多少像素内视为「贴底」：静默刷新时保持吸底，否则保留阅读位置。 */
const BOTTOM_STICK_PX = 56;
/** focus 自动刷新的最小间隔：点击窗口（拖动/缩放必先聚焦）不应立刻引发网络拉取。 */
const FOCUS_REFRESH_MIN_MS = 30_000;

const ICON_LOGO = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H13l-4.2 3.4a.6.6 0 0 1-1-.45V16.5h-.3A3.5 3.5 0 0 1 4 12.5Z"/><path d="M8.5 8.5h7M8.5 11.7h4.5"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.46-5.74"/><path d="M20 3.6V8h-4.4"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg>';
const ICON_EMPTY = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v5.5a4 4 0 0 1-4 4h-4.6L8 19.8a.55.55 0 0 1-.9-.42V16.5H8a4 4 0 0 1-4-4Z"/><path d="M8.4 8.1h7.2M8.4 11.4h4.2"/></svg>';

interface SavedContext {
  token: string;
  userId: string;
  session: Pick<MskSession, 'id' | 'name' | 'characterId' | 'characterName'> | null;
}

/** 触发方式决定渲染与滚动策略：open=打开窗口、manual=点刷新、auto=focus/storage 静默。 */
type LoadMode = 'open' | 'manual' | 'auto';

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

/** 日期分隔标签：今天/昨天/同年 M月D日/跨年全日期。 */
function dayLabel(createdAt: string | undefined): { key: string; label: string } | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86400000);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const label = days <= 0 ? '今天'
    : days === 1 ? '昨天'
    : date.getFullYear() === now.getFullYear() ? `${month}月${day}日`
    : `${date.getFullYear()}年${month}月${day}日`;
  return { key: date.toDateString(), label };
}

/** 日期由分隔条承载，消息头只留时分。 */
function timeLabel(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

class RecordsView {
  private readonly app = document.getElementById('app')!;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly toBottom: HTMLButtonElement;
  private operation: AbortController | null = null;
  private renderer: MskMessageRenderer | null = null;
  private rendered: MskRendered[] = [];
  private contextKey = '';
  /** 已渲染时间线的签名（会话+条数+末条 id）：没变就不动 DOM，杜绝刷新闪烁与滚动跳动。 */
  private signature = '';
  private loading = false;
  private hasContent = false;
  private statusTimer = 0;
  private pinFrame = 0;
  private lastFocusLoad = 0;

  constructor() {
    this.app.innerHTML = `<main class="records-shell">
      <header class="records-header">
        <div class="records-brand"><span class="records-logo">${ICON_LOGO}</span><div class="records-heading"><span class="records-kicker">ALIYA ARCHIVE</span><h1>聊天记录</h1></div></div>
        <div class="records-side"><div class="records-session"><span class="records-title"></span><span class="records-meta"></span></div><button type="button" class="records-refresh" title="刷新" aria-label="刷新">${ICON_REFRESH}</button></div>
      </header>
      <div class="records-status" role="status" aria-live="polite"></div>
      <section class="records-list" aria-label="聊天记录"></section>
      <button type="button" class="records-tobottom" title="回到底部" aria-label="回到底部">${ICON_DOWN}</button>
    </main>`;
    this.title = this.app.querySelector('.records-title')!;
    this.meta = this.app.querySelector('.records-meta')!;
    this.refreshButton = this.app.querySelector('.records-refresh')!;
    this.list = this.app.querySelector('.records-list')!;
    this.status = this.app.querySelector('.records-status')!;
    this.toBottom = this.app.querySelector('.records-tobottom')!;
    this.refreshButton.onclick = () => { void this.load('manual'); };
    this.toBottom.onclick = () => { this.list.scrollTo({ top: this.list.scrollHeight, behavior: 'smooth' }); };
    this.list.addEventListener('scroll', () => this.syncToBottom(), { passive: true });
    // 用户在钉底期间接管滚动：立即取消钉底，不与输入抢滚动条。
    const cancelPin = () => cancelAnimationFrame(this.pinFrame);
    this.list.addEventListener('wheel', cancelPin, { passive: true });
    this.list.addEventListener('pointerdown', cancelPin, { passive: true });
    window.addEventListener('focus', () => {
      const now = Date.now();
      if (now - this.lastFocusLoad < FOCUS_REFRESH_MIN_MS) return;
      this.lastFocusLoad = now;
      void this.load('auto');
    });
    window.addEventListener('storage', event => {
      if ([MSK_TOKEN_KEY, MSK_USER_KEY, CONTROL_REQUEST_KEY].includes(event.key ?? '') || event.key?.startsWith('aliya_session:')) {
        void this.load('auto');
      }
    });
  }

  async load(mode: LoadMode): Promise<void> {
    const saved = savedContext();
    const request = readControlRequest(localStorage);
    const navigate = request?.action === 'navigate' && request.sessionId === saved.session?.id ? request : null;
    const nextKey = `${saved.userId}:${saved.session?.id ?? ''}:${navigate?.at ?? ''}`;
    // records-open 与 focus/storage 常同时触发：同上下文加载已在进行就别重复拉取。
    if (this.loading && nextKey === this.contextKey) return;
    this.contextKey = nextKey;
    this.operation?.abort();
    const operation = new AbortController();
    this.operation = operation;
    this.loading = true;
    this.refreshButton.disabled = true;
    this.refreshButton.classList.add('loading');
    this.setStatus('');
    // 无闪烁刷新：已有内容保留到本次数据落地再整体替换，只有空列表才上骨架屏。
    const animate = !this.hasContent;
    if (!this.hasContent) this.showSkeleton();
    const stickToBottom = mode !== 'auto' || this.isAtBottom();
    const prevScroll = this.list.scrollTop;

    try {
      if (!saved.token) {
        this.title.textContent = '';
        this.meta.textContent = '';
        this.showEmpty('尚未连接 Misskey', '请先在聊天窗口完成授权。');
        return;
      }
      if (!saved.session) {
        this.title.textContent = '';
        this.meta.textContent = '';
        this.showEmpty('尚未选择会话', '回到聊天窗口选择一个会话后，这里会显示记录。');
        return;
      }
      this.title.textContent = saved.session.name || saved.session.characterName || 'Aliya';
      const client = new MskClient(saved.token);
      const api: MskApiCaller = (endpoint, body, signal) => client.post('/' + endpoint, body, signal);

      if (navigate) {
        this.meta.textContent = '上下文定位';
        const ready = await this.ensureRenderer(api, saved.session, operation);
        if (!ready) return;
        const messages = await client.messagesAround(saved.session.id, navigate.messageId!, operation.signal);
        if (operation.signal.aborted) return;
        const count = this.renderMessages(saved.session.id, messages, { targetId: navigate.messageId, divider: navigate.divider, animate });
        this.hasContent = count > 0;
        this.signature = '';
        if (readControlRequest(localStorage)?.at === navigate.at) localStorage.removeItem(CONTROL_REQUEST_KEY);
        this.afterRender('target', prevScroll);
        return;
      }

      const messages = await client.timeline(saved.session.id, HISTORY_FETCH_LIMIT, operation.signal);
      if (operation.signal.aborted) return;
      const signature = `${saved.session.id}:${messages.length}:${messages[messages.length - 1]?.id ?? ''}`;
      if (!messages.length) {
        this.signature = signature;
        this.meta.textContent = `最近 ${HISTORY_ROUND_LIMIT} 轮 · 0 条`;
        this.showEmpty('还没有聊天记录', '在聊天窗口和 Aliya 说点什么吧。');
        return;
      }
      if (mode !== 'manual' && signature === this.signature && this.hasContent) {
        // 数据未变：不重渲染，已有 DOM（含事件绑定）原样保留，只按触发原因归位滚动。
        if (stickToBottom) this.pinBottom();
        return;
      }
      const ready = await this.ensureRenderer(api, saved.session, operation);
      if (!ready) return;
      const count = this.renderLatest(saved.session.id, messages, animate);
      this.signature = signature;
      this.hasContent = count > 0;
      this.meta.textContent = `最近 ${HISTORY_ROUND_LIMIT} 轮 · ${count} 条`;
      this.afterRender(stickToBottom ? 'bottom' : 'preserve', prevScroll);
    } catch (error) {
      if (operation.signal.aborted) return;
      if (this.hasContent) this.setStatus(error instanceof Error ? error.message : '记录读取失败，请稍后重试。', 'error', true);
      else this.showEmpty('记录读取失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      if (this.operation === operation) {
        this.loading = false;
        this.refreshButton.disabled = false;
        this.refreshButton.classList.remove('loading');
      }
    }
  }

  /** 拉取角色渲染配置并重建渲染器；返回 false 表示已中止。仅在确定要渲染时调用。 */
  private async ensureRenderer(api: MskApiCaller, session: NonNullable<SavedContext['session']>, operation: AbortController): Promise<boolean> {
    const detail = await api<{ characterStickers?: unknown; characterId?: string }>('agents/sessions/show', { sessionId: session.id }, operation.signal);
    const character = await api<{ regexRules?: unknown }>('agents/characters/show', {
      characterId: detail.characterId || session.characterId || ALIYA_CHARACTER_ID,
    }, operation.signal).catch(() => ({ regexRules: [] as unknown[] }));
    if (operation.signal.aborted) return false;
    this.clearRendering();
    this.renderer = new MskMessageRenderer({
      api,
      openUrl: url => { void openUrl(url); },
      onImageClick: url => { void openUrl(url); },
      regexRules: normalizeRegexRules(character.regexRules),
      resolveSticker: buildStickerResolver(normalizeCharacterStickers(detail.characterStickers)),
      loadEmojis: signal => fetchCustomEmojis(api, signal),
      autoDraw: false,
    });
    return true;
  }

  private renderLatest(sessionId: string, messages: MskTimelineMessage[], animate: boolean): number {
    const start = lastRoundsStart(messages, HISTORY_ROUND_LIMIT);
    const slice = messages.slice(start);
    const frag = document.createDocumentFragment();
    if (start > 0 || messages.length >= HISTORY_FETCH_LIMIT) {
      const note = document.createElement('div');
      note.className = 'records-truncated';
      note.textContent = `更早的对话已省略 · 仅显示最近 ${HISTORY_ROUND_LIMIT} 轮`;
      frag.append(note);
    }
    return this.renderMessages(sessionId, slice, { animate, prepend: frag });
  }

  private renderMessages(
    sessionId: string,
    messages: MskTimelineMessage[],
    options: { targetId?: string; divider?: boolean; animate?: boolean; prepend?: DocumentFragment } = {},
  ): number {
    const frag = options.prepend ?? document.createDocumentFragment();
    let target: HTMLElement | null = null;
    let lastDay = '';
    let count = 0;
    for (const message of messages) {
      if (message.role === 'system' && message.id !== options.targetId) continue;
      const day = dayLabel(message.createdAt);
      if (day && day.key !== lastDay) {
        lastDay = day.key;
        const divider = document.createElement('div');
        divider.className = 'record-day';
        divider.textContent = day.label;
        frag.append(divider);
      }
      const article = document.createElement('article');
      article.className = `record-message record-${message.role}`;
      const head = document.createElement('header');
      const author = document.createElement('strong');
      author.textContent = message.role === 'system' ? '上下文分界' : message.role === 'user' ? '你' : 'Aliya';
      const time = document.createElement('time');
      time.textContent = timeLabel(message.createdAt);
      if (message.createdAt) time.dateTime = message.createdAt;
      head.append(author, time);
      if (message.role === 'assistant') {
        const replay = document.createElement('button');
        replay.type = 'button';
        replay.className = 'record-replay';
        replay.textContent = '重新播放';
        replay.title = '在桌宠对话框中重新播放这条回复';
        replay.onclick = () => { void this.replayMessage(sessionId, message.id, replay); };
        head.append(replay);
      }
      const body = document.createElement('div');
      body.className = 'message-text';
      article.append(head, body);
      frag.append(article);
      count++;
      if (message.role === 'system') body.textContent = options.divider ? '从这里开始新的上下文' : message.content || '上下文分界';
      else this.bindMessage(sessionId, message, body);
      if (message.id === options.targetId) {
        target = article;
        article.classList.add('record-target');
        article.tabIndex = -1;
      }
    }
    this.list.classList.toggle('no-anim', !options.animate);
    this.list.replaceChildren(frag);
    if (!target && options.targetId) this.setStatus('目标消息已删除或不在可见记录中。', 'error', true);
    return count;
  }

  /** 渲染后统一处理滚动：定位目标居中 / 钉底 / 保留阅读位置。 */
  private afterRender(mode: 'target' | 'bottom' | 'preserve', prevScroll: number): void {
    if (mode === 'target') {
      requestAnimationFrame(() => {
        const target = this.list.querySelector<HTMLElement>('.record-target');
        if (target) {
          target.scrollIntoView({ block: 'center' });
          target.focus({ preventScroll: true });
        }
        this.syncToBottom();
      });
      return;
    }
    if (mode === 'bottom') {
      this.pinBottom();
      return;
    }
    this.list.scrollTo({ top: Math.min(prevScroll, Math.max(0, this.list.scrollHeight - this.list.clientHeight)), behavior: 'instant' });
    this.syncToBottom();
  }

  /**
   * 钉底：生图卡片异步落定（占位 88px → 图 320px）与图片解码都会再撑高内容，
   * 单次 scrollTop 落地的一定不是真底部。rAF 循环跟住 scrollHeight 直到稳定或超时；
   * 滚轮/指针输入随时取消（构造器里挂了取消监听）。
   * 全程 instant：CSS 的 scroll-behavior:smooth 会把「跳到底」变成从头滚下来的巡演。
   */
  private pinBottom(duration = 2800): void {
    cancelAnimationFrame(this.pinFrame);
    const stop = performance.now() + duration;
    let last = -1;
    const tick = () => {
      const height = this.list.scrollHeight;
      if (height !== last) {
        last = height;
        this.list.scrollTo({ top: height, behavior: 'instant' });
      }
      this.syncToBottom();
      if (performance.now() < stop) this.pinFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private isAtBottom(): boolean {
    return this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - BOTTOM_STICK_PX;
  }

  private syncToBottom(): void {
    this.toBottom.classList.toggle('show', !this.isAtBottom());
  }

  private setStatus(text: string, kind: 'info' | 'error' = 'info', transient = false): void {
    window.clearTimeout(this.statusTimer);
    this.status.textContent = text;
    this.status.dataset.kind = kind;
    this.status.classList.toggle('show', text !== '');
    if (transient && text) this.statusTimer = window.setTimeout(() => this.setStatus(''), 4200);
  }

  private showSkeleton(): void {
    const frag = document.createDocumentFragment();
    for (const [width, side, lines] of [[46, 'left', 2], [30, 'right', 1], [58, 'left', 3], [36, 'right', 1], [42, 'left', 2]] as const) {
      const row = document.createElement('div');
      row.className = `record-skeleton${side === 'right' ? ' right' : ''}`;
      row.style.setProperty('--w', `${width}%`);
      for (let i = 0; i < lines; i++) row.append(document.createElement('i'));
      frag.append(row);
    }
    this.list.replaceChildren(frag);
  }

  private async replayMessage(sessionId: string, messageId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.setStatus('正在打开对话框……');
    try {
      localStorage.setItem(CONTROL_REQUEST_KEY, JSON.stringify({ sessionId, messageId, action: 'replay', at: Date.now() }));
      if (platform === 'tauri') {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('show_chat');
      }
      this.setStatus('已在对话框中重新播放。', 'info', true);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : '重新播放失败，请重试。', 'error', true);
    } finally {
      button.disabled = false;
    }
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
    this.hasContent = false;
    this.list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'records-empty';
    empty.innerHTML = ICON_EMPTY;
    const heading = document.createElement('h2');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    empty.append(heading, paragraph);
    if (platform === 'tauri') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'records-open-chat';
      action.textContent = '打开聊天窗口';
      action.onclick = () => {
        void import('@tauri-apps/api/core').then(m => m.invoke('show_chat')).catch(() => {});
      };
      empty.append(action);
    }
    this.list.append(empty);
    this.setStatus('');
  }

  private clearRendering(): void {
    for (const task of this.rendered) task.cancel();
    this.rendered = [];
  }
}

const view = new RecordsView();
if (platform === 'tauri') {
  const { listen } = await import('@tauri-apps/api/event');
  await listen('records-open', () => { void view.load('open'); });
} else {
  void view.load('open');
}
