import { ChatController, type ChatStorage } from './controller';
import type { ChatMessage } from './types';
import { Typewriter } from './typewriter';
import { MskAuth } from './msk/auth';
import { DEFAULT_MSK_ORIGIN, MSK_BASE, mskSessionKey } from './msk/config';
import { CONTROL_REQUEST_KEY, readControlRequest } from './msk/control-bridge';
import { ALIYA_CHARACTER_ID, MskClient, type MskSession } from './msk/client';
import { MskChatProvider } from './msk/provider';
import { MskMessageRenderer, type MskRendered } from './rendering/renderer';
import { normalizeRegexRules } from './rendering/rules';
import { buildStickerResolver, normalizeCharacterStickers, fetchCustomEmojis } from './rendering/emoji';
import type { MskApiCaller } from './rendering/types';
import { openUrl, platform } from '../platform';
import './chat.css';

/** 会话列表用的简短相对时间。 */
function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export class ChatView {
  readonly root = document.createElement('div');
  isOpen = false;
  pointerActive = false;
  private screen: 'connect' | 'sessions' | 'ready' = 'connect';
  private sequence = 0;
  private operation: AbortController | null = null;
  private renderer: MskMessageRenderer | null = null;
  private rendered: MskRendered[] = [];
  private activeSession: MskSession | null = null;
  private lastAnswer = '';
  private historyVisible = false;
  private lastBusy = false;
  private composing = false;
  private controlRequestActive = false;
  /** 回复分页播放状态：segments 为渲染产物中的 .msk-segment（MSK 展示分段）。 */
  private replyActive = false;
  private replyToken: unknown = null;
  /** settled 之后才 true：此前的 onUpdate 只服务隐藏容器，不做分页。 */
  private playing = false;
  private segments: HTMLElement[] = [];
  private pageIndex = 0;
  private typewriter: Typewriter | null = null;
  private readonly panel: HTMLElement;
  private readonly content: HTMLElement;
  private readonly composer: HTMLFormElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLElement;

  constructor(readonly controller: ChatController, private readonly auth: MskAuth,
    private readonly onOpen: (open: boolean) => void, private readonly storage?: ChatStorage) {
    this.root.id = 'chat-ui';
    this.root.innerHTML = `
      <button class="chat-launcher" aria-label="和 Aliya 聊天">聊天</button>
      <div class="chat-shell">
        <section class="gal-panel" aria-label="Aliya 对话" hidden>
          <header class="gal-nameplate"><strong>Aliya</strong><span class="panel-title"></span><button class="close-panel" aria-label="关闭对话框">×</button></header>
          <div class="gal-content" tabindex="0"></div>
          <footer class="gal-footer" hidden><span class="page-hint"></span><button class="dismiss-reply">收起</button></footer>
        </section>
        <form class="chat-composer" hidden>
          <textarea aria-label="对 Aliya 说" placeholder="对 Aliya 说……" rows="1" maxlength="2000"></textarea>
          <div class="composer-toolbar"><button type="button" class="history">记录</button><button type="button" class="sessions">会话</button><span class="chat-status" role="status"></span><button type="button" class="stop" hidden>停止等待</button><button type="submit" class="send">发送</button><button type="button" class="close-window" aria-label="关闭聊天窗口">×</button></div>
        </form>
      </div>`;
    document.body.append(this.root);
    this.panel = this.get('.gal-panel'); this.content = this.get('.gal-content');
    this.composer = this.get('.chat-composer'); this.input = this.get('textarea'); this.status = this.get('.chat-status');
    this.get('.chat-launcher').onclick = () => this.setOpen(true);
    this.get('.close-window').onclick = () => this.close();
    this.get('.close-panel').onclick = () => { if (this.screen === 'ready') this.hideReply(); else this.close(); };
    this.get('.dismiss-reply').onclick = () => this.hideReply();
    this.content.addEventListener('click', e => this.onContentClick(e));
    this.get('.history').onclick = () => this.showHistory();
    this.get('.sessions').onclick = () => { void this.loadSessions(); };
    this.get('.stop').onclick = () => { this.controller.stop(); this.status.textContent = '已停止等待；服务器可能仍在生成，可在记录中刷新。'; };
    this.composer.onsubmit = e => { e.preventDefault(); this.send(); };
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.composing && e.keyCode !== 229) { e.preventDefault(); this.send(); }
    };
    this.input.oninput = () => {
      this.input.style.height = 'auto'; this.input.style.height = `${Math.min(92, this.input.scrollHeight)}px`;
    };
    this.input.onfocus = () => this.notify(); this.input.onblur = () => this.notify();
    this.root.onpointerdown = () => { this.pointerActive = true; };
    window.addEventListener('pointerup', () => { this.pointerActive = false; });
    window.addEventListener('blur', () => { this.pointerActive = false; this.notify(); });
    this.root.onkeydown = e => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); this.hideReply(); } };
    controller.persist = false;
    controller.onChange = () => this.changed();
    window.addEventListener('storage', e => { if (e.key === CONTROL_REQUEST_KEY) void this.applyControlRequest(); });
    window.addEventListener('focus', () => { void this.applyControlRequest(); });
    void this.bootstrap();
  }
  private get<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  get typing(): boolean { return document.activeElement === this.input; }
  hitRects(): DOMRect[] { return (this.isOpen ? [this.panel, this.composer] : [this.get('.chat-launcher')]).map(e => e.getBoundingClientRect()).filter(r => r.width && r.height); }
  setOpen(open: boolean): void {
    this.isOpen = open;
    this.get('.chat-launcher').hidden = open;
    this.composer.hidden = !open || this.screen !== 'ready';
    this.panel.hidden = !open || (this.screen === 'ready' && !this.historyVisible);
    // 独立窗口打开即聚焦，点完「聊天」按钮直接可以打字；内嵌模式不抢软键盘。
    if (open && this.screen === 'ready' && platform === 'tauri') this.input.focus();
    document.body.classList.toggle('chat-open', open);
    this.updateLayoutMode();
    this.onOpen(open); this.notify();
  }
  private close(): void {
    this.setOpen(false);
    if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('hide_chat'));
  }
  private notify(): void {
    // 运行态经壳汇总后全局广播 chat-state {busy, typing, open}（open 由壳按窗口可见性裁定）。
    if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('set_chat_state', { busy: this.controller.busy, typing: this.typing })).catch(() => {});
  }
  private reset(): AbortSignal {
    this.operation?.abort(); this.operation = new AbortController(); ++this.sequence;
    this.controller.stop(); this.clearPlayback(); this.clearRendering(); this.renderer?.cancelAll();
    return this.operation.signal;
  }
  private clearRendering(): void { for (const task of this.rendered) task.cancel(); this.rendered = []; }
  private showPanel(title: string): void {
    this.get('.panel-title').textContent = title;
    this.panel.hidden = !this.isOpen;
    this.get('.gal-footer').hidden = true;
    this.updateLayoutMode();
  }
  /** 根据面板/输入框可见性切换紧凑布局：只有输入框时贴脚显示，有面板时上下连成一张卡片。 */
  private updateLayoutMode(): void {
    const shell = this.get('.chat-shell');
    const panelVisible = this.isOpen && !this.panel.hidden;
    const composerVisible = this.isOpen && !this.composer.hidden;
    shell.classList.toggle('with-panel', panelVisible);
    shell.classList.toggle('composer-only', composerVisible && !panelVisible);
    document.body.dataset.chatLayout = !this.isOpen ? 'closed'
      : composerVisible && !panelVisible ? 'composer'
        : this.screen === 'ready' ? 'reply' : 'setup';
    this.reportLayout();
  }
  /** 独立窗口把内容态交给壳，壳据此调整外窗高度并重新紧贴 pet；内嵌模式无需处理。 */
  private reportLayout(): void {
    if (platform !== 'tauri') return;
    const mode = document.body.dataset.chatLayout ?? 'setup';
    requestAnimationFrame(() => {
      const shell = this.get('.chat-shell');
      const height = Math.ceil(shell.getBoundingClientRect().height + 6);
      void import('@tauri-apps/api/core')
        .then(m => m.invoke('set_chat_layout', { mode, contentHeight: height }))
        .catch(() => {});
    });
  }
  private showConnect(message = ''): void {
    this.screen = 'connect'; this.composer.hidden = true; this.clearRendering();
    this.content.innerHTML = `<h2>连接 Misskey</h2><p>在浏览器中授权，然后选择与 Aliya 的会话。</p><div class="auth-actions"><button class="authorize btn-primary">打开浏览器授权</button><button class="reconnect ghost">重试连接</button><button class="cancel-auth ghost">取消</button></div><details><summary>使用已有 token</summary><form class="manual"><input type="password" autocomplete="off" aria-label="Misskey token"><button class="btn-primary">连接</button></form></details><p class="auth-status" role="status"></p>`;
    this.get('.auth-status').textContent = message;
    this.get('.authorize').onclick = () => { void this.login(); };
    this.get('.reconnect').hidden = !this.auth.token;
    this.get('.reconnect').onclick = () => { void this.bootstrap(); };
    this.get('.cancel-auth').onclick = () => { this.operation?.abort(); this.showConnect('已取消。'); };
    this.get<HTMLFormElement>('.manual').onsubmit = e => { e.preventDefault(); void this.login(this.get<HTMLInputElement>('.manual input').value); };
    this.showPanel('连接');
  }
  private async bootstrap(): Promise<void> {
    const signal = this.reset();
    this.showConnect('正在恢复连接……');
    try {
      const resumed = await this.auth.resumeCallback(signal);
      if (!resumed && !this.auth.token) { this.showConnect(); return; }
      if (!resumed) await this.auth.validateSaved(signal);
      if (!signal.aborted) await this.loadSessions(true);
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private async login(token?: string): Promise<void> {
    const signal = this.reset(); this.showConnect('等待授权……');
    this.get<HTMLButtonElement>('.authorize').disabled = true;
    try {
      if (token !== undefined) await this.auth.loginManual(token, signal); else await this.auth.loginBrowser(signal);
      if (!signal.aborted) await this.loadSessions();
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private async loadSessions(restore = false): Promise<void> {
    const signal = this.reset(); this.screen = 'sessions'; this.composer.hidden = true;
    this.content.textContent = '正在读取会话……'; this.showPanel('选择会话');
    try {
      const list = await new MskClient(this.auth.token).listAliyaSessions(signal);
      if (signal.aborted) return;
      const key = this.sessionKey();
      let savedId: string | null = null;
      try {
        const saved = JSON.parse(this.storage?.getItem(key) ?? 'null') as { id?: unknown } | null;
        savedId = typeof saved?.id === 'string' ? saved.id : null;
      } catch { /* Optional storage. */ }
      const selected = restore ? list.find(s => s.id === savedId) : null;
      if (selected) { await this.enterSession(selected); return; }
      this.content.replaceChildren();
      if (!list.length) this.content.textContent = '还没有与 Aliya 的会话，请在 Misskey 创建后刷新。';
      // 最近活跃的会话排前面，省去翻找。
      list.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
      for (const session of list) {
        const row = document.createElement('button'); row.className = 'session-row';
        const title = document.createElement('span'); title.textContent = session.name || session.characterName || 'Aliya';
        row.append(title);
        if (session.hasUnread) { const dot = document.createElement('i'); dot.className = 'unread-dot'; dot.title = '有新消息'; row.append(dot); }
        const sub = [session.lastMessagePreview?.trim(), relativeTime(session.lastMessageAt)].filter(Boolean).join(' · ');
        if (sub) { const small = document.createElement('small'); small.textContent = sub; row.append(small); }
        row.onclick = () => { void this.enterSession(session); }; this.content.append(row);
      }
      const actions = document.createElement('div'); actions.className = 'session-actions';
      const refresh = document.createElement('button'); refresh.textContent = '刷新'; refresh.className = 'ghost'; refresh.onclick = () => { void this.loadSessions(); }; actions.append(refresh);
      const logout = document.createElement('button'); logout.textContent = '退出账号'; logout.className = 'ghost'; logout.onclick = () => this.disconnect(); actions.append(logout);
      this.content.append(actions);
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private sessionKey(): string { return mskSessionKey(this.auth.savedUser()?.id ?? 'current'); }
  private async enterSession(session: MskSession): Promise<void> {
    const signal = this.reset(); this.content.textContent = '正在打开会话……';
    const client = new MskClient(this.auth.token);
    const api: MskApiCaller = (endpoint, body, s) => client.post('/' + endpoint, body, s);
    try {
      const [detail, character, timeline] = await Promise.all([
        api<Record<string, unknown>>('agents/sessions/show', { sessionId: session.id }, signal),
        api<{ regexRules?: unknown }>('agents/characters/show', { characterId: session.characterId || ALIYA_CHARACTER_ID }, signal).catch(() => ({ regexRules: [] })),
        client.timeline(session.id, 60, signal),
      ]);
      if (signal.aborted) return;
      this.activeSession = session;
      this.renderer = new MskMessageRenderer({ api, openUrl: url => { void openUrl(url); }, onImageClick: url => { void openUrl(url); },
        regexRules: normalizeRegexRules(character.regexRules), resolveSticker: buildStickerResolver(normalizeCharacterStickers(detail.characterStickers)),
        loadEmojis: s => fetchCustomEmojis(api, s), autoDraw: false });
      this.controller.useProvider(new MskChatProvider(client, session.id));
      this.controller.replaceHistory(timeline.map(m => ({ id: m.id, messageId: m.id, role: m.role as 'user' | 'assistant', text: m.content, file: m.file, status: 'complete' })));
      this.lastAnswer = this.controller.latest?.id ?? '';
      this.screen = 'ready'; this.historyVisible = false; this.panel.hidden = true; this.composer.hidden = !this.isOpen;
      this.input.disabled = false; this.status.textContent = ''; this.updateLayoutMode();
      // 存 id+名称：名称供设置主菜单「当前会话」展示。
      try { this.storage?.setItem(this.sessionKey(), JSON.stringify({ id: session.id, name: session.name || session.characterName || 'Aliya' })); } catch { /* Optional storage. */ }
      this.notify();
      void this.applyControlRequest();
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private disconnect(): void {
    this.reset(); this.auth.logout(); this.activeSession = null;
    this.controller.replaceHistory([]); this.input.value = ''; this.showConnect('已退出账号。'); this.notify();
  }
  private send(): void {
    if (this.screen !== 'ready' || this.controller.busy || this.composing) return;
    const text = this.input.value.trim(); if (!text) return;
    this.input.value = ''; this.showPending(); void this.controller.send(text);
  }
  private changed(): void {
    const c = this.controller;
    this.get<HTMLButtonElement>('.send').disabled = c.busy;
    this.get('.stop').hidden = !c.busy;
    this.status.textContent = c.busy ? '等待回应…' : c.error ? '回复未完成' : '';
    if (this.screen === 'ready' && this.lastBusy && !c.busy) {
      if (c.latest?.role === 'assistant' && c.latest.status === 'complete' && c.latest.id !== this.lastAnswer) {
        this.lastAnswer = c.latest.id; this.showReply(c.latest);
      } else if (c.error) {
        this.clearPlayback(); this.clearRendering(); this.content.textContent = c.error;
        const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = () => { void c.retry(); };
        this.content.append(retry); this.showPanel('未完成');
      } else {
        // 用户停止等待：收起「正在输入」占位。
        this.hideReply();
      }
    }
    this.lastBusy = c.busy; this.notify();
    if (!c.busy) void this.applyControlRequest();
  }
  private bindMessage(message: ChatMessage, container: HTMLElement, segmented = false, onUpdate?: () => void) {
    if (!this.renderer || !this.activeSession) return null;
    const task = this.renderer.render({ sessionId: this.activeSession.id, messageId: message.messageId || message.id,
      text: message.text, role: message.role, file: message.file, liveArrived: false, segmented, onUpdate });
    task.bind(container); this.rendered.push(task);
    return task;
  }
  /** 发送后立即弹出面板显示「正在输入」占位，回复到达后由 showReply 替换。 */
  private showPending(): void {
    if (this.screen !== 'ready') return;
    this.historyVisible = false; this.clearPlayback(); this.clearRendering();
    this.content.replaceChildren(); this.content.scrollTop = 0;
    const dots = document.createElement('div'); dots.className = 'typing-dots'; dots.setAttribute('aria-label', 'Aliya 正在输入');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    this.content.append(dots); this.showPanel('');
  }
  /**
   * 回复按 MSK 展示分段逐页播放：每页一句，逐字冒出；
   * 点击对话框补完当前页，补完后点击翻页，末页点击收起。
   * 渲染是异步的（表情表/生图状态查询），等 settled 再开始播放，
   * 避免生图状态的首轮更新把刚冒出的文字冲掉；播放先显示「正在输入」占位。
   */
  private showReply(message: ChatMessage): void {
    this.historyVisible = false; this.clearPlayback(); this.clearRendering();
    this.content.replaceChildren(); this.content.scrollTop = 0;
    this.replyActive = true;
    const dots = document.createElement('div'); dots.className = 'typing-dots'; dots.setAttribute('aria-label', 'Aliya 正在输入');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const text = document.createElement('div'); text.className = 'message-text'; text.style.visibility = 'hidden';
    this.content.append(dots, text);
    const token = message.id;
    this.replyToken = token;
    const task = this.bindMessage(message, text, message.role === 'assistant', () => this.resyncPages());
    this.showPanel(''); this.updateHint();
    if (!task) { this.replyActive = false; this.updateHint(); return; }
    void task.settled.then(() => {
      if (!this.replyActive || this.replyToken !== token) return;
      dots.remove(); text.style.visibility = '';
      this.playing = true;
      this.resyncPages();
    });
  }
  /** 渲染产物更新后重排分页：首次出现分段时开始逐字播放，后续更新（生图状态）保持当前页静态显示。 */
  private resyncPages(): void {
    if (!this.replyActive || !this.playing) return;
    const segments = [...this.content.querySelectorAll<HTMLElement>('.msk-segment')];
    if (!segments.length) return;
    if (segments.length === this.segments.length && segments.every((s, i) => s === this.segments[i])) return;
    const firstPaint = this.segments.length === 0;
    this.segments = segments;
    this.pageIndex = Math.min(this.pageIndex, segments.length - 1);
    this.typewriter?.cancel(); this.typewriter = null;
    this.showPage(this.pageIndex, firstPaint);
  }
  private showPage(index: number, animate: boolean): void {
    this.pageIndex = index;
    this.segments.forEach((s, i) => { s.hidden = i !== index; });
    const page = this.segments[index];
    this.typewriter?.cancel(); this.typewriter = null;
    if (page && animate) {
      page.classList.add('gal-page-in');
      this.typewriter = new Typewriter(page);
      this.typewriter.onDone = () => this.updateHint();
      this.typewriter.start();
    }
    this.content.scrollTop = 0;
    this.updateHint();
  }
  private onContentClick(e: MouseEvent): void {
    if (!this.replyActive || this.screen !== 'ready' || this.historyVisible || !this.segments.length) return;
    // 链接/图片/生图按钮交给渲染器处理，不参与翻页；划选文本也不翻页。
    if ((e.target as Element | null)?.closest('a,button,img,[data-msk-action]')) return;
    const selection = this.content.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (this.typewriter?.typing) { this.typewriter.finish(); return; }
    if (this.pageIndex < this.segments.length - 1) this.showPage(this.pageIndex + 1, true);
    else this.hideReply();
  }
  private updateHint(): void {
    const footer = this.get('.gal-footer');
    const hint = this.get('.page-hint');
    this.panel.classList.toggle('replying', this.screen === 'ready' && this.replyActive);
    footer.hidden = !(this.screen === 'ready' && this.replyActive);
    if (footer.hidden) return;
    const total = this.segments.length;
    const page = this.pageIndex + 1;
    hint.classList.toggle('blink', !this.typewriter?.typing && total > 0);
    if (!total) hint.textContent = '';
    else if (this.typewriter?.typing) hint.textContent = total > 1 ? `${page}/${total}` : '';
    else if (page < total) hint.textContent = `▼ 点击继续 ${page}/${total}`;
    else hint.textContent = total > 1 ? `▼ 点击收起 ${page}/${total}` : '▼ 点击收起';
  }
  private clearPlayback(): void {
    this.replyActive = false; this.replyToken = null; this.playing = false;
    this.segments = []; this.pageIndex = 0;
    this.typewriter?.cancel(); this.typewriter = null;
  }
  private hideReply(): void {
    if (this.screen !== 'ready') return;
    this.panel.hidden = true; this.historyVisible = false;
    this.clearPlayback(); this.clearRendering(); this.updateLayoutMode();
  }
  private showHistory(): void {
    if (this.screen !== 'ready') return;
    this.clearPlayback(); this.clearRendering(); this.historyVisible = true; this.content.replaceChildren(); this.showPanel('记录');
    const refresh = document.createElement('button'); refresh.textContent = '刷新记录'; refresh.className = 'ghost';
    refresh.onclick = () => { void this.refreshHistory(); }; this.content.append(refresh);
    if (!this.controller.messages.length) {
      const empty = document.createElement('p'); empty.className = 'muted-note'; empty.textContent = '还没有聊天记录，说点什么吧。'; this.content.append(empty);
    }
    for (const message of this.controller.messages) {
      const article = document.createElement('article'); const label = document.createElement('small'); label.className = message.role === 'user' ? 'who-user' : 'who-aliya'; label.textContent = message.role === 'user' ? '你' : 'Aliya';
      const text = document.createElement('div'); text.className = 'message-text'; article.append(label, text); this.content.append(article); this.bindMessage(message, text);
    }
  }
  private async refreshHistory(): Promise<void> {
    if (!this.activeSession || this.controller.busy) return;
    const seq = this.sequence;
    try {
      const list = await new MskClient(this.auth.token).timeline(this.activeSession.id, 60, this.operation?.signal);
      if (seq !== this.sequence) return;
      this.controller.replaceHistory(list.map(m => ({ id: m.id, messageId: m.id, role: m.role as 'user' | 'assistant', text: m.content, file: m.file, status: 'complete' })));
      this.showHistory();
    } catch (e) { this.status.textContent = this.error(e); }
  }
  private async applyControlRequest(): Promise<void> {
    if (this.screen !== 'ready' || this.controller.busy || this.controlRequestActive) return;
    const request = readControlRequest(this.storage);
    if (!request || request.sessionId !== this.activeSession?.id) return;
    this.controlRequestActive = true;
    const seq = this.sequence;
    try {
      if (readControlRequest(this.storage)?.at === request.at) this.storage?.removeItem(CONTROL_REQUEST_KEY);
      if (request.action === 'deleted') {
        this.activeSession = null; this.controller.replaceHistory([]); await this.loadSessions(); return;
      }
      if (request.action === 'refresh') {
        await this.enterSession(this.activeSession); return;
      }
      const messages = await new MskClient(this.auth.token).messagesAround(request.sessionId, request.messageId!, this.operation?.signal);
      if (seq !== this.sequence) return;
      this.setOpen(true); this.showHistory(); this.clearRendering(); this.content.replaceChildren();
      const refresh = document.createElement('button'); refresh.textContent = '回到最新记录'; refresh.className = 'ghost';
      refresh.onclick = () => { void this.refreshHistory(); }; this.content.append(refresh);
      let target: HTMLElement | null = null;
      for (const message of messages) {
        if (message.role === 'system' && message.id !== request.messageId) continue;
        const article = document.createElement('article');
        const label = document.createElement('small');
        label.textContent = message.role === 'system' ? '上下文分界' : message.role === 'user' ? '你' : 'Aliya';
        const text = document.createElement('div'); text.className = 'message-text'; article.append(label, text); this.content.append(article);
        if (message.role === 'system') text.textContent = '从这里开始新的上下文';
        else this.bindMessage({ id: message.id, messageId: message.id, role: message.role, text: message.content, file: message.file, status: 'complete' }, text);
        if (message.id === request.messageId) { target = article; article.classList.add('history-target'); article.tabIndex = -1; }
      }
      if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
      else this.status.textContent = '目标消息已删除或不在可见记录中。';
    } catch (e) { if (seq === this.sequence) this.status.textContent = this.error(e); }
    finally { this.controlRequestActive = false; }
  }
  private error(e: unknown): string { return e instanceof Error ? e.message : '连接失败，请重试。'; }
}
