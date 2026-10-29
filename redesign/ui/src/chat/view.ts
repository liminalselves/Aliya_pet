import { ChatController, type ChatStorage } from './controller';
import type { ChatMessage, PerformanceCue } from './types';
import { Typewriter } from './typewriter';
import { MskAuth } from './msk/auth';
import { DEFAULT_MSK_ORIGIN, MSK_BASE, mskSessionKey } from './msk/config';
import { CONTROL_REQUEST_KEY, readControlRequest } from './msk/control-bridge';
import { ALIYA_CHARACTER_ID, MAX_UPLOAD_BYTES, MskClient, type MskSession } from './msk/client';
import { MskChatProvider } from './msk/provider';
import { MskMessageRenderer, type MskRendered } from './rendering/renderer';
import { normalizeRegexRules } from './rendering/rules';
import { buildStickerResolver, normalizeCharacterStickers } from './rendering/emoji';
import { cachedCharacterRules, cachedCustomEmojis } from './msk/cache';
import type { MskApiCaller } from './rendering/types';
import { openUrl, platform, shellAction } from '../platform';
import { loadSettings } from '../settings';
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

/** 记录屏：拉取上限与展示上限（轮 = 一条用户消息及其后的 Aliya 回复）。 */
const HISTORY_FETCH_LIMIT = 100;
const HISTORY_ROUND_LIMIT = 50;

/** 表演指令页（.msk-cue）派发后的停顿：不建打字机，静默自动翻页。 */
const CUE_PAGE_MS = 400;

/**
 * 焦点回归只消化这个时效内的控制请求。新鲜请求在写入（storage 事件）或忙碌
 * 结束时已被消费；陈留至今的是漏网残留，消化它会让「点一下输入框突然重播旧消息」。
 */
const CONTROL_FOCUS_MAX_AGE_MS = 20_000;

/** 取末尾最近 N 轮的起始下标；不足 N 轮返回 0。 */
function lastRoundsStart(messages: ChatMessage[], rounds: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      seen++;
      if (seen === rounds) return i;
    }
  }
  return 0;
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
  /** 时间线拉满整页：服务器上很可能还有更早的记录（用于截断提示）。 */
  private historyMayHaveMore = false;
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
  private cueTimer: ReturnType<typeof setTimeout> | null = null;
  /** 面板收起动画计时器：动画结束才补 hidden；重新展示前必须取消。 */
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 整体入场一次性 class 的摘除计时器（关→开跳变时由 playEnter 挂上）。 */
  private enterTimer: ReturnType<typeof setTimeout> | null = null;
  /** 整体退出动画计时器：播完才真正 setOpen(false)/关窗；重开前必须取消。 */
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 内嵌模式面板高度补间（翻页/锁高变化）；新补间先取消旧的。 */
  private morph: Animation | null = null;
  /** startPage 锁定的本页高度，showPage 据此补间。 */
  /** 面板最近一次布局后的可见高度（ResizeObserver 异步回写）：同步替换内容后它仍是旧高，作补间起点。 */
  private panelHeight = 0;
  private readonly panel: HTMLElement;
  private readonly content: HTMLElement;
  private readonly composer: HTMLFormElement;
  private readonly input: HTMLTextAreaElement;
  private readonly status: HTMLElement;
  /** 待发送图片：选中即本地预览；发送时上传，拿到 Drive 文件后缓存（失败重发不重复上传）。 */
  private attachment: { blob: Blob; name: string; url: string; uploaded: import('./rendering/types').DriveFileLike | null } | null = null;
  private uploading = false;

  constructor(readonly controller: ChatController, private readonly auth: MskAuth,
    private readonly onOpen: (open: boolean) => void, private readonly storage?: ChatStorage) {
    this.root.id = 'chat-ui';
    this.root.innerHTML = `
      <button class="chat-launcher" aria-label="和 Aliya 聊天"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h.5H7.5A2.5 2.5 0 0 1 5 12.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span>聊天</span></button>
      <div class="chat-shell">
        <section class="gal-panel" aria-label="Aliya 对话" hidden>
          <button class="close-panel" aria-label="关闭对话框"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
          <div class="gal-content" tabindex="0"></div>
          <footer class="gal-footer"><span class="page-hint"></span></footer>
        </section>
        <form class="chat-composer" hidden>
          <div class="composer-attachment" hidden><img alt="待发送的图片"><button type="button" class="remove-attachment" title="移除图片" aria-label="移除图片"><svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><span class="attachment-state"></span></div>
          <div class="composer-row"><textarea aria-label="对 Aliya 说" placeholder="对 Aliya 说……" rows="1" maxlength="2000"></textarea><span class="composer-action"><button type="button" class="stop" title="停止等待回复" aria-label="停止等待回复" disabled><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg></button><button type="submit" class="send" title="发送（Enter）" aria-label="发送"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span></div>
          <div class="composer-toolbar"><button type="button" class="history">记录</button><button type="button" class="sessions">会话</button><button type="button" class="session-config" title="配置当前会话">配置</button><button type="button" class="app-settings" title="打开桌宠设置">设置</button><span class="chat-status" role="status"></span><button type="button" class="attach" title="发送图片" aria-label="发送图片"><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.2" cy="8.2" r="1.45" fill="currentColor"/><path d="M3.2 14.2l4.1-3.9 2.9 2.6 2.4-2.1 4.2 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg></button><input type="file" class="attach-input" accept="image/*" hidden><button type="button" class="close-window" title="关闭" aria-label="关闭聊天窗口"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
        </form>
      </div>`;
    document.body.append(this.root);
    this.panel = this.get('.gal-panel'); this.content = this.get('.gal-content');
    this.composer = this.get('.chat-composer'); this.input = this.get('textarea'); this.status = this.get('.chat-status');
    this.get('.chat-launcher').onclick = () => this.setOpen(true);
    this.get('.close-window').onclick = () => this.close();
    this.get('.close-panel').onclick = () => { if (this.screen === 'ready') this.hideReply(); else this.close(); };
    // 捕获阶段挂面板：先于渲染器冒泡监听（图片外部打开）消费点击，纯图片页也点得动。
    this.panel.addEventListener('click', e => this.onPanelClick(e), true);
    this.get('.history').onclick = () => {
      if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('show_records')).catch(() => {});
      else if (platform === 'android') shellAction('open-records');
      else this.showHistory();
    };
    this.get('.sessions').onclick = () => { void this.loadSessions(); };
    this.get('.session-config').onclick = () => {
      if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('show_settings', { target: 'session-control' })).catch(() => {});
      else if (platform === 'android') shellAction('open-session-control');
    };
    this.get('.session-config').hidden = platform === 'web';
    this.get('.app-settings').onclick = () => {
      if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('show_settings', { target: 'main' })).catch(() => {});
      else if (platform === 'android') shellAction('open-settings');
    };
    this.get('.app-settings').hidden = platform === 'web';
    this.get('.stop').onclick = () => { this.controller.stop(); this.status.textContent = '已停止等待；服务器可能仍在生成，可在记录中刷新。'; this.reportLayout(); };
    this.composer.onsubmit = e => { e.preventDefault(); this.send(); };
    const picker = this.get<HTMLInputElement>('.attach-input');
    this.get('.attach').onclick = () => { if (!this.attachBlocked()) picker.click(); };
    picker.onchange = () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (file) this.setAttachment(file);
    };
    this.get('.remove-attachment').onclick = () => { if (!this.uploading) this.setAttachment(null); };
    // 粘贴图片（截图后 Ctrl+V）直接作为附件。
    this.input.addEventListener('paste', e => {
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.kind === 'file' && i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file || this.attachBlocked()) return;
      e.preventDefault();
      this.setAttachment(file);
    });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.composing && e.keyCode !== 229) { e.preventDefault(); this.send(); }
    };
    this.input.oninput = () => {
      this.syncComposerState();
      const max = platform === 'android' ? 112 : 88;
      this.input.style.height = 'auto'; this.input.style.height = `${Math.min(max, this.input.scrollHeight)}px`;
      this.reportLayout();
    };
    this.input.onfocus = () => this.notify(); this.input.onblur = () => this.notify();
    this.root.onpointerdown = () => { this.pointerActive = true; };
    window.addEventListener('pointerup', () => { this.pointerActive = false; });
    window.addEventListener('blur', () => { this.pointerActive = false; this.notify(); });
    this.root.onkeydown = e => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); this.hideReply(); } };
    controller.persist = false;
    controller.onChange = () => this.changed();
    window.addEventListener('storage', e => { if (e.key === CONTROL_REQUEST_KEY) void this.applyControlRequest(); });
    window.addEventListener('focus', () => {
      // 焦点回归只消化新鲜请求；陈旧的直接清掉，不再补播（见常量注释）。
      const request = readControlRequest(this.storage);
      if (request && Date.now() - request.at > CONTROL_FOCUS_MAX_AGE_MS) {
        if (readControlRequest(this.storage)?.at === request.at) this.storage?.removeItem(CONTROL_REQUEST_KEY);
        return;
      }
      void this.applyControlRequest();
    });
    // 生图/附图解码晚于翻页锁高：载入后按真实高度重新锁高。
    // 逐字播放中文本是收起的，此时量高会误判，跳过（播完 onDone 已补量）。
    this.content.addEventListener('load', e => {
      const img = e.target as Element | null;
      if (!(img instanceof HTMLImageElement) || img.closest('[hidden]') || !img.closest('.msk-draw-card,.msk-attachment,.msk-sticker,.msk-emoji-img')) return;
      if (this.screen !== 'ready' || !this.replyActive || this.historyVisible || this.typewriter?.typing) return;
      this.reportLayout();
    }, true);
    // 只响应宽度变化（随 pet 缩放）：宽度决定换行，进而决定页高。
    let layoutWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === layoutWidth) return;
      layoutWidth = window.innerWidth;
      if (!this.typewriter?.typing) this.reportLayout();
    });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(entries => {
        const entry = entries[entries.length - 1];
        if (entry) this.onPanelResize(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }).observe(this.panel);
    }
    this.syncComposerState();
    void this.bootstrap();
  }
  private get<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  get typing(): boolean { return document.activeElement === this.input; }
  hitRects(): DOMRect[] { return (this.isOpen ? [this.panel, this.composer] : [this.get('.chat-launcher')]).map(e => e.getBoundingClientRect()).filter(r => r.width && r.height); }
  setOpen(open: boolean): void {
    this.cancelLeave();
    if (open) this.cancelExit();
    const wasOpen = this.isOpen;
    if (!open) {
      this.clearPlayback();
      this.clearRendering();
      this.replyActive = false;
      this.historyVisible = false;
      this.cancelShellEnter();
      (document.activeElement as HTMLElement | null)?.blur();
    }
    this.isOpen = open;
    this.get('.chat-launcher').hidden = open;
    // 输入框是常驻锚点：切屏（连接/会话）只禁用不隐藏——显隐切换会让卡片
    // 在过渡帧撕裂（面板方角底边悬空），是用户视频的闪烁源之一。
    this.composer.hidden = !open;
    this.panel.hidden = !open || (this.screen === 'ready' && !this.historyVisible);
    if (this.panel.hidden) this.panel.style.animation = '';
    // 独立窗口打开即聚焦，点完「聊天」按钮直接可以打字；内嵌模式不抢软键盘。
    if (open && this.screen === 'ready' && platform === 'tauri') this.input.focus();
    document.body.classList.toggle('chat-open', open);
    if (open && !wasOpen) this.playEnter();
    this.updateLayoutMode();
    this.onOpen(open); this.notify();
  }
  /**
   * 聊天整体入场动画（chat.css .shell-enter）：挂一次性 class，播完摘除。
   * 两条入口：setOpen 关→开跳变；窗口重现（window.ts 的 chat-state 补播，
   * 彼时 isOpen 已是 true，走不到 setOpen 的跳变分支）。
   */
  playEnter(): void {
    if (!this.isOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const shell = this.get('.chat-shell');
    shell.classList.remove('shell-enter');
    void shell.offsetWidth;
    shell.classList.add('shell-enter');
    if (this.enterTimer) clearTimeout(this.enterTimer);
    this.enterTimer = setTimeout(() => { this.enterTimer = null; shell.classList.remove('shell-enter'); }, 320);
  }
  private cancelShellEnter(): void {
    if (this.enterTimer) { clearTimeout(this.enterTimer); this.enterTimer = null; }
    this.get('.chat-shell').classList.remove('shell-enter');
  }
  private cancelExit(): void {
    if (this.exitTimer) { clearTimeout(this.exitTimer); this.exitTimer = null; }
    this.get('.chat-shell').classList.remove('shell-exit');
  }
  handleBack(): boolean {
    if (!this.isOpen) return false;
    if (this.screen === 'ready' && !this.panel.hidden) this.hideReply();
    else this.close();
    return true;
  }
  /**
   * 关闭先播 150ms 整体退出动画（chat.css .shell-exit），再真正收窗/关态：
   * WebView2 上窗口级补间不可行（分步 resize 残影），DOM 淡出是关闭仅有的平滑手段。
   * 动画期间重开（pet 按钮/启动器）由 setOpen(true) 的 cancelExit 拦截。
   */
  private close(): void {
    if (this.exitTimer) return;
    const shell = this.get('.chat-shell');
    if (this.isOpen && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.cancelShellEnter();
      this.cancelLeave();
      shell.classList.add('shell-exit');
      this.exitTimer = setTimeout(() => {
        this.exitTimer = null;
        shell.classList.remove('shell-exit');
        this.setOpen(false);
        if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('hide_chat'));
      }, 150);
      return;
    }
    this.setOpen(false);
    if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('hide_chat'));
  }
  /**
   * 输入区状态：empty 灰化发送键；busy 让停止键原位替换发送键（chat.css .composer-action）；
   * errored 驱动状态行样式。占位符随屏态/等待态切换，连接与会话屏禁用，等待回复时只读
   * （保留焦点，回复落地即可接着打字）。
   */
  private syncComposerState(): void {
    if (!this.composer?.classList || !this.input) return;
    const busy = this.controller.busy === true;
    const ready = this.screen === 'ready';
    this.composer.classList.toggle('empty', !this.input.value.trim() && !this.attachment);
    const attach = this.composer.querySelector<HTMLButtonElement>('.attach');
    if (attach) attach.disabled = this.attachBlocked();
    const remove = this.composer.querySelector<HTMLButtonElement>('.remove-attachment');
    if (remove) remove.disabled = this.uploading || busy;
    this.composer.classList.toggle('busy', busy);
    this.composer.classList.toggle('errored', !busy && !!this.controller.error);
    this.input.disabled = !ready;
    this.input.readOnly = ready && busy;
    const hint = !ready ? (this.screen === 'connect' ? '先连接 Misskey…' : '先选择会话…') : busy ? 'Aliya 正在想……' : '对 Aliya 说……';
    if (this.input.placeholder === hint) return;
    this.input.placeholder = hint;
    // 占位符换字时淡入（有输入内容时占位符不可见，不必播）。
    if (this.input.value || !this.input.classList) return;
    this.input.classList.remove('hint-in');
    void this.input.offsetWidth;
    this.input.classList.add('hint-in');
  }
  private notify(): void {
    // 运行态经壳汇总后全局广播 chat-state {busy, typing, open}（open 由壳按窗口可见性裁定）。
    if (platform === 'tauri') void import('@tauri-apps/api/core').then(m => m.invoke('set_chat_state', { busy: this.controller.busy, typing: this.typing })).catch(() => {});
  }
  private reset(): AbortSignal {
    this.operation?.abort(); this.operation = new AbortController(); ++this.sequence;
    if (this.uploading) {
      this.uploading = false;
      this.root.querySelector('.composer-attachment')?.classList.remove('uploading');
      const state = this.root.querySelector('.attachment-state'); if (state) state.textContent = '';
    }
    this.controller.stop(); this.clearPlayback(); this.clearRendering(); this.renderer?.cancelAll();
    return this.operation.signal;
  }
  private clearRendering(): void { for (const task of this.rendered) task.cancel(); this.rendered = []; }
  private showPanel(_title = ''): void {
    // 从隐藏态重新出现必须重播入场：撤掉打断淡出时留下的内联 animation:none。
    if (this.panel.hidden) this.panel.style.animation = '';
    this.cancelLeave();
    this.panel.hidden = !this.isOpen;
    this.updateHint();
    this.updateLayoutMode();
  }
  /** 取消未播完的收起动画：面板重新展示前必须撤销 leaving 态与补 hidden 的计时器。 */
  private cancelLeave(): void {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    if (!this.panel.classList.contains('leaving')) return;
    // 淡出到一半被新内容打断：从当前不透明度/位移接着浮回。直接摘 class 会让 CSS 入场
    // 动画从 0 重播（0.7→0 闪一下）；内联 animation:none 挡住它，直到下一次收起再撤掉。
    const { opacity, transform } = getComputedStyle(this.panel);
    this.panel.style.animation = 'none';
    this.panel.classList.remove('leaving');
    this.panel.animate?.([{ opacity, transform }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
  /**
   * 内容区入场：stagger 让子项依次浮现（会话行/记录条目/连接屏分块），
   * fade 用于单行加载占位。class 留在容器上由 CSS 驱动，再次调用先强制重排重触发。
   */
  private animateContent(mode: 'fade' | 'stagger'): void {
    this.clearContentAnimation();
    void this.content.offsetWidth;
    this.content.classList.add(mode === 'fade' ? 'fade-in' : 'stagger-in');
  }
  /** 回复流（打字点/分页播放）不参与错落动画：分段显隐已各有专用动效。 */
  private clearContentAnimation(): void {
    this.content.classList.remove('fade-in', 'stagger-in');
  }
  /**
   * 面板收起分两步：先播退出动画（chat.css .leaving），锁高保持到动画结束，
   * 再补 hidden 解锁。输入框底锚不动，面板只在原地下沉淡出。
   */
  private hidePanelAnimated(): void {
    if (this.panel.hidden || this.panel.classList.contains('leaving')) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { this.panel.hidden = true; this.unlockPanel(); this.updateLayoutMode(); return; }
    this.stopMorph();
    this.panel.style.animation = '';
    this.panel.classList.add('leaving');
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.panel.classList.remove('leaving');
      this.panel.hidden = true;
      if (!this.replyActive) this.unlockPanel();
      this.updateLayoutMode();
    }, 150);
  }
  /** 根据面板/输入框可见性切换布局态（Android 回复卡限高依赖 data-chat-layout）。 */
  private updateLayoutMode(): void {
    const shell = this.get('.chat-shell');
    // leaving 期间仍算可见：退出动画播完前布局态（min/max-height）不能先变。
    const panelVisible = this.isOpen && !this.panel.hidden;
    const composerVisible = this.isOpen && !this.composer.hidden;
    shell.classList.toggle('with-panel', panelVisible);
    shell.classList.toggle('composer-only', composerVisible && !panelVisible);
    // 发送键跟随屏态：非 ready 屏输入框已禁用，发送键同步置灰（changed 只维护 busy）。
    this.get<HTMLButtonElement>('.send').disabled = this.screen !== 'ready' || this.controller.busy;
    document.body.dataset.chatLayout = !this.isOpen ? 'closed'
      : composerVisible && !panelVisible ? 'composer'
        : this.screen === 'ready' && !this.historyVisible ? 'reply' : 'setup';
    this.reportLayout();
  }
  /**
   * 同步输入区高度（面板 max-height 依赖它），回复页播完/资源落地后按真实内容重新锁高。
   * 外窗高度固定（Windows chat 窗不随内容 resize，见 chat_window.rs），面板伸缩全在 DOM 内补间。
   */
  private reportLayout(): void {
    const composerHeight = this.composer.hidden ? 0 : this.composer.offsetHeight;
    document.body.style.setProperty('--chat-composer-height', `${composerHeight}px`);
    if (this.replyActive && this.playing && !this.typewriter?.typing) this.lockPanel();
  }
  private showConnect(message = ''): void {
    this.screen = 'connect'; this.clearRendering();
    this.syncComposerState();
    this.content.innerHTML = `<h2>连接 Misskey</h2><p>在浏览器中授权，然后选择与 Aliya 的会话。</p><div class="auth-actions"><button class="authorize btn-primary">打开浏览器授权</button><button class="reconnect ghost">重试连接</button><button class="cancel-auth ghost">取消</button></div><details><summary>使用已有 token</summary><form class="manual"><input type="password" autocomplete="off" aria-label="Misskey token"><button class="btn-primary">连接</button></form></details><p class="auth-status" role="status"></p>`;
    this.get('.auth-status').textContent = message;
    this.get('.authorize').onclick = () => { void this.login(); };
    this.get('.reconnect').hidden = !this.auth.token;
    this.get('.reconnect').onclick = () => { void this.bootstrap(); };
    this.get('.cancel-auth').onclick = () => { this.operation?.abort(); this.showConnect('已取消。'); };
    this.get<HTMLFormElement>('.manual').onsubmit = e => { e.preventDefault(); void this.login(this.get<HTMLInputElement>('.manual input').value); };
    this.showPanel('连接');
    this.animateContent('stagger');
  }
  private async bootstrap(): Promise<void> {
    const signal = this.reset();
    this.showConnect('正在恢复连接……');
    try {
      const resumed = await this.auth.resumeCallback(signal);
      if (!resumed && !this.auth.token) { this.showConnect(); return; }
      if (resumed) { if (!signal.aborted) await this.loadSessions(true); return; }
      // 已存 token：验权（刷新用户资料）与读会话列表并行，省掉一个串行往返；
      // token 失效时会话列表同样返回 401，提示一致。
      // 预取用独立控制器：loadSessions 内 reset() 会中止当前 operation，预取不能随之作废。
      const prefetch = new AbortController();
      const sessions = new MskClient(this.auth.token).listAliyaSessions(prefetch.signal);
      sessions.catch(() => {});
      try { await this.auth.validateSaved(signal); } catch (e) { prefetch.abort(); throw e; }
      if (signal.aborted) { prefetch.abort(); return; }
      await this.loadSessions(true, sessions);
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
  private async loadSessions(restore = false, prefetched?: Promise<MskSession[]>): Promise<void> {
    const signal = this.reset(); this.screen = 'sessions';
    this.syncComposerState();
    // 加载占位也走 stagger 槽位：占位行就是列表的第 0 项，列表落地同位替换，布局不跳。
    this.content.innerHTML = '<p class="muted-note loading-note">正在读取会话</p>'; this.showPanel('选择会话');
    this.animateContent('stagger');
    try {
      const list = await (prefetched ?? new MskClient(this.auth.token).listAliyaSessions(signal));
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
      if (!list.length) {
        const empty = document.createElement('p'); empty.className = 'muted-note';
        empty.textContent = '还没有与 Aliya 的会话。可以创建会话，或打开 Misskey 管理现有会话。';
        this.content.append(empty);
      }
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
      const create = document.createElement('button'); create.textContent = '新建会话'; create.className = 'btn-primary';
      create.onclick = async () => {
        create.disabled = true;
        try {
          const session = await new MskClient(this.auth.token).createSession(signal);
          if (!signal.aborted) await this.enterSession(session);
        } catch (e) {
          if (!signal.aborted) {
            create.disabled = false;
            const error = document.createElement('p'); error.className = 'auth-status'; error.textContent = this.error(e);
            actions.querySelector('.auth-status')?.remove(); actions.append(error);
          }
        }
      };
      actions.append(create);
      const manage = document.createElement('button'); manage.textContent = 'Misskey'; manage.className = 'ghost';
      manage.onclick = () => { void openUrl(`${MSK_BASE}/chat`); }; actions.append(manage);
      const refresh = document.createElement('button'); refresh.textContent = '刷新'; refresh.className = 'ghost'; refresh.onclick = () => { void this.loadSessions(); }; actions.append(refresh);
      const logout = document.createElement('button'); logout.textContent = '退出账号'; logout.className = 'ghost'; logout.onclick = () => this.disconnect(); actions.append(logout);
      this.content.append(actions);
      // 加载占位→列表一次性成型：不换屏只换内容，纯淡入盖住替换帧，不重放面板入场。
      this.animateContent('stagger');
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private sessionKey(): string { return mskSessionKey(this.auth.savedUser()?.id ?? 'current'); }
  private async enterSession(session: MskSession): Promise<void> {
    const signal = this.reset();
    this.content.innerHTML = '<p class="muted-note loading-note">正在打开会话</p>'; this.animateContent('fade');
    const client = new MskClient(this.auth.token);
    const api: MskApiCaller = (endpoint, body, s) => client.post('/' + endpoint, body, s);
    try {
      const [detail, regexRules, timeline] = await Promise.all([
        api<Record<string, unknown>>('agents/sessions/show', { sessionId: session.id }, signal),
        cachedCharacterRules(api, session.characterId || ALIYA_CHARACTER_ID),
        client.timeline(session.id, HISTORY_FETCH_LIMIT, signal),
      ]);
      if (signal.aborted) return;
      this.activeSession = session;
      this.historyMayHaveMore = timeline.length >= HISTORY_FETCH_LIMIT;
      this.renderer = new MskMessageRenderer({ api, openUrl: url => { void openUrl(url); }, onImageClick: url => { void openUrl(url); },
        regexRules: normalizeRegexRules(regexRules), resolveSticker: buildStickerResolver(normalizeCharacterStickers(detail.characterStickers)),
        loadEmojis: () => cachedCustomEmojis(api), autoDraw: false,
        get showGeneratedImages() { return loadSettings().showGeneratedImages; } });
      this.controller.useProvider(new MskChatProvider(client, session.id));
      this.controller.replaceHistory(timeline.map(m => ({ id: m.id, messageId: m.id, role: m.role as 'user' | 'assistant', text: m.content, file: m.file, status: 'complete' })));
      this.lastAnswer = this.controller.latest?.id ?? '';
      this.screen = 'ready'; this.historyVisible = false;
      this.status.textContent = ''; this.syncComposerState();
      // 会话面板两步退出（同 hideReply）：淡出期间窗口保持原高，播完单步收缩；
      // 直接 hidden 会让「正在打开会话……」凭空消失一帧（用户视频的闪烁帧）。
      this.hidePanelAnimated();
      this.updateLayoutMode();
      // 存 id+名称：名称供设置主菜单「当前会话」展示。
      try {
        this.storage?.setItem(this.sessionKey(), JSON.stringify({
          id: session.id,
          name: session.name || session.characterName || 'Aliya',
          characterId: session.characterId,
          characterName: session.characterName || 'Aliya',
        }));
      } catch { /* Optional storage. */ }
      this.notify();
      void this.applyControlRequest();
    } catch (e) { if (!signal.aborted) this.showConnect(this.error(e)); }
  }
  private disconnect(): void {
    this.reset(); this.auth.logout(); this.activeSession = null;
    this.controller.replaceHistory([]); this.input.value = ''; this.setAttachment(null); this.showConnect('已退出账号。'); this.notify();
  }
  private attachBlocked(): boolean {
    return this.screen !== 'ready' || this.controller?.busy === true || this.uploading;
  }
  /** 选中/替换/移除待发送图片（一条消息一张，与服务端一致）。 */
  private setAttachment(file: Blob | null, name = 'image'): void {
    if (this.attachment) URL.revokeObjectURL(this.attachment.url);
    this.attachment = null;
    const box = this.get('.composer-attachment');
    const state = this.get('.attachment-state');
    state.textContent = ''; box.classList.remove('failed', 'uploading');
    if (file && !file.type.startsWith('image/')) { this.status.textContent = '只能发送图片。'; file = null; }
    else if (file && file.size > MAX_UPLOAD_BYTES) { this.status.textContent = '图片太大了（上限 20MB）。'; file = null; }
    if (file) {
      const fileName = file instanceof File && file.name ? file.name : `${name}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      this.attachment = { blob: file, name: fileName, url: URL.createObjectURL(file), uploaded: null };
      this.get<HTMLImageElement>('.composer-attachment img').src = this.attachment.url;
      if (this.status.textContent === '只能发送图片。' || this.status.textContent === '图片太大了（上限 20MB）。') this.status.textContent = '';
    }
    const show = !!this.attachment;
    if (show && box.hidden) { box.hidden = false; box.classList.remove('attach-in'); void box.offsetWidth; box.classList.add('attach-in'); }
    else if (!show) box.hidden = true;
    this.syncComposerState();
    this.reportLayout();
    if (show && platform === 'tauri') this.input.focus();
  }
  private send(): void {
    if (this.screen !== 'ready' || this.controller.busy || this.composing || this.uploading) return;
    const text = this.input.value.trim();
    const attachment = this.attachment;
    if (!text && !attachment) return;
    if (!attachment) {
      this.input.value = ''; this.input.style.height = ''; this.syncComposerState();
      this.showPending(); void this.controller.send(text);
      return;
    }
    void this.sendWithImage(text, attachment);
  }
  /** 先上传图片拿 fileId 再发消息；上传失败保留图片与文字，可直接重发。 */
  private async sendWithImage(text: string, attachment: NonNullable<ChatView['attachment']>): Promise<void> {
    const sequence = this.sequence;
    const box = this.get('.composer-attachment');
    const state = this.get('.attachment-state');
    let file = attachment.uploaded;
    if (!file) {
      this.uploading = true; box.classList.remove('failed'); box.classList.add('uploading');
      state.textContent = '上传中'; this.status.textContent = ''; this.syncComposerState();
      try {
        file = await new MskClient(this.auth.token).uploadFile(attachment.blob, attachment.name, this.operation?.signal);
      } catch (e) {
        if (sequence !== this.sequence || this.attachment !== attachment) return;
        box.classList.add('failed'); state.textContent = '上传失败';
        this.status.textContent = this.error(e);
        return;
      } finally {
        if (sequence === this.sequence) { this.uploading = false; box.classList.remove('uploading'); this.syncComposerState(); }
      }
      // 上传期间换了会话/图片：本次结果作废。
      if (sequence !== this.sequence || this.attachment !== attachment || this.screen !== 'ready') return;
      attachment.uploaded = file;
    }
    this.input.value = ''; this.input.style.height = '';
    this.setAttachment(null);
    this.showPending(); void this.controller.send(text, file);
  }
  private changed(): void {
    const c = this.controller;
    this.get<HTMLButtonElement>('.send').disabled = c.busy || this.screen !== 'ready';
    this.get<HTMLButtonElement>('.stop').disabled = !c.busy;
    // 等待提示在输入框占位里显示（等待期间不可输入）；状态行只留停止/错误等需要留意的信息。
    this.status.textContent = c.busy ? '' : c.error ? '回复未完成' : this.status.textContent === '回复未完成' ? '' : this.status.textContent;
    this.syncComposerState();
    if (this.screen === 'ready' && this.lastBusy && !c.busy) {
      if (c.latest?.role === 'assistant' && c.latest.status === 'complete' && c.latest.id !== this.lastAnswer) {
        this.lastAnswer = c.latest.id; this.showReply(c.latest);
      } else if (c.error) {
        this.clearPlayback(); this.clearRendering(); this.content.replaceChildren();
        const box = document.createElement('div'); box.className = 'reply-error';
        const text = document.createElement('p'); text.textContent = c.error;
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新发送'; retry.className = 'btn-primary';
        retry.onclick = () => { retry.disabled = true; void c.retry(); };
        box.append(text, retry); this.content.append(box);
        this.showPanel('未完成'); this.animateContent('fade');
      } else {
        // 用户停止等待：收起「正在输入」占位。
        this.hideReply();
      }
    }
    this.lastBusy = c.busy; this.notify();
    // 状态提示/停止按钮会改变输入区高度，需在变更后的布局帧重新量高。
    this.reportLayout();
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
    this.clearContentAnimation();
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
    this.clearContentAnimation();
    this.content.replaceChildren(); this.content.scrollTop = 0;
    this.replyActive = true;
    const dots = document.createElement('div'); dots.className = 'typing-dots'; dots.setAttribute('aria-label', 'Aliya 正在输入');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    // 渲染器先构建整条回复；准备期间必须脱离布局，不能只设 visibility:hidden。
    const text = document.createElement('div'); text.className = 'message-text'; text.hidden = true;
    this.content.append(dots, text);
    const token = message.id;
    this.replyToken = token;
    const task = this.bindMessage(message, text, message.role === 'assistant', () => {
      if (!this.playing) return;
      this.resyncPages();
      // 生图/表情异步落地后页面会变高；逐字播放中文本是收起的，此时量高会误判，跳过。
      if (!this.typewriter?.typing) this.reportLayout();
    });
    this.showPanel(''); this.updateHint();
    if (!task) { this.replyActive = false; this.updateHint(); return; }
    void task.settled.then(() => {
      if (!this.replyActive || this.replyToken !== token) return;
      // 打点立即移除（占位高度影响翻页量高），正文淡入接管视觉衔接；面板高度由 onPanelResize 补间。
      dots.remove(); text.hidden = false; text.classList.add('gal-text-in');
      this.playing = true;
      this.resyncPages();
    });
  }
  /** 渲染产物更新后重排分页：首次出现分段时开始逐字播放，后续更新（生图状态）保持当前页静态显示。 */
  private resyncPages(): void {
    if (!this.replyActive || !this.playing) return;
    const segments = [...this.content.querySelectorAll<HTMLElement>('.msk-segment')];
    // 仅含配图的回复在关闭配图后没有可播放页，不留下空白面板。
    if (!segments.length) { this.hideReply(); return; }
    if (segments.length === this.segments.length && segments.every((s, i) => s === this.segments[i])) return;
    const firstPaint = this.segments.length === 0;
    this.segments = segments;
    this.pageIndex = Math.min(this.pageIndex, segments.length - 1);
    this.typewriter?.cancel(); this.typewriter = null;
    this.showPage(this.pageIndex, firstPaint);
  }
  /**
   * 面板高度补间：任何高度变化（翻页锁高、解锁、加载占位换成列表、窗口变宽）都在布局后、
   * 绘制前被 ResizeObserver 捕获，用 WAAPI 从上次高度过渡到新高度，首帧即是旧高，不闪跳。
   * 显示/隐藏交给入场/退出动画；补间中间帧不更新基准。
   */
  private onPanelResize(height: number): void {
    if (this.panel.hidden) { this.panelHeight = 0; return; }
    if (this.morph) return;
    const from = this.panelHeight;
    this.panelHeight = height;
    this.morphPanel(from, height);
  }
  private morphPanel(from: number, height: number): void {
    if (!from || Math.abs(height - from) < 2 || !this.panel.animate || this.panel.classList.contains('leaving')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const morph = this.panel.animate([{ height: `${from}px` }, { height: `${height}px` }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    // 在 ResizeObserver 回调里新建的动画默认 pending 一帧，那一帧会以新高度绘制（闪跳）；钉住起始时间立即生效。
    if (document.timeline?.currentTime != null) morph.startTime = document.timeline.currentTime;
    this.morph = morph;
    morph.onfinish = () => { if (this.morph === morph) this.morph = null; };
  }
  /** 停掉进行中的补间，基准取当前可见高度：随后的新目标从这里接着过渡。 */
  private stopMorph(): void {
    if (!this.morph) return;
    this.panelHeight = this.panel.offsetHeight;
    this.morph.cancel(); this.morph = null;
  }
  /**
   * 按页锁高：翻页时在打字机清空文字前量出本页完整高度并钉住面板，逐字揭示只往里填，
   * 卡片不再边打边长。量出自然高后按当前 max-height 钳制再锁定（超高页在锁定高度内滚动）。
   */
  private lockPanel(): number {
    if (!this.panel?.style || this.panel.hidden) return 0;
    // 进行中的补间会覆盖 CSS 高度，量到的是中间帧（锁矮的根因），先停掉。
    this.stopMorph();
    // 旧锁高仍钉着面板：此刻可见高就是补间起点，同步起补间，不等 ResizeObserver。
    const from = this.panel.style.getPropertyValue('--chat-panel-height') ? this.panel.offsetHeight : 0;
    const max = parseFloat(getComputedStyle(this.panel).maxHeight);
    this.root.classList.add('layout-measuring');
    let height = 0;
    try { height = Math.ceil(this.panel.offsetHeight); }
    finally { this.root.classList.remove('layout-measuring'); }
    if (Number.isFinite(max) && max > 0) height = Math.min(height, Math.floor(max));
    if (height > 0) this.panel.style.setProperty('--chat-panel-height', `${height}px`);
    else this.panel.style.removeProperty('--chat-panel-height');
    if (height > 0) { this.panelHeight = height; this.morphPanel(from, height); }
    return height;
  }
  private unlockPanel(): void {
    this.panel?.style?.removeProperty('--chat-panel-height');
  }
  private showPage(index: number, animate: boolean): void {
    this.applyPage(index);
    this.startPage(index, animate);
  }
  private applyPage(index: number): void {
    this.pageIndex = index;
    this.segments.forEach((s, i) => { s.hidden = i !== index; });
    this.typewriter?.cancel(); this.typewriter = null;
    this.clearCueTimer();
    this.updateHint();
  }
  private startPage(index: number, animate: boolean): void {
    const page = this.segments[index];
    if (page && page.classList.contains('msk-cue')) {
      // 指令页：不建打字机；首次翻到时派发表演（幂等标记防 resync 重入重放），短暂停顿后自动翻页
      if (animate && !page.dataset.dispatched) {
        page.dataset.dispatched = '1';
        const cue: PerformanceCue = {};
        if (page.dataset.express) cue.expression = page.dataset.express;
        if (page.dataset.play) cue.action = page.dataset.play;
        this.controller.onCue(cue);
      }
      this.cueTimer = setTimeout(() => {
        this.cueTimer = null;
        if (!this.replyActive || this.pageIndex !== index) return;
        if (index + 1 < this.segments.length) this.showPage(index + 1, true);
        else this.completeReply();
      }, CUE_PAGE_MS);
      this.updateHint();
      return;
    }
    // 页脚先落定，再按当前完整页一次锁高；后续逐字揭示不改变卡片尺寸。
    this.updateHint();
    this.lockPanel();
    if (page && animate) {
      page.classList.add('gal-page-in');
      this.typewriter = new Typewriter(page);
      // 播放中跟随最新冒出的文字；播完回到页首——超高页（大图/长文）默认从顶部读起。
      this.typewriter.onProgress = () => { this.content.scrollTop = this.content.scrollHeight; };
      this.typewriter.onDone = () => {
        this.content.scrollTop = 0;
        this.updateHint();
        // 图片等异步资源可能在播放结束后才载入完成，补一次量高。
        this.reportLayout();
      };
      this.typewriter.start();
    }
    this.content.scrollTop = 0;
    this.updateHint();
  }
  private clearCueTimer(): void {
    if (this.cueTimer) { clearTimeout(this.cueTimer); this.cueTimer = null; }
  }
  /**
   * GAL 式推进：播放中点击直接补完本页，播完点击翻下一页，末页点击收起。
   * 播放期间图片点击（渲染器的 msk-zoom 外部打开）让位给翻页——纯图片页占满
   * 点击区域，不拦截会表现为「点不动」；放大看图仍可在记录里点。
   * 链接/生图按钮等真交互控件不翻页。播放中 gal-content 为 user-select:none
   * （见 chat.css），点击不会触发浏览器选词——可选文本时快速连点会双击选词/
   * 三击选段，选区反复重建既吞点击又闪高亮（「点不动/误选中」的根因）。
   */
  private onPanelClick(e: MouseEvent): void {
    if (!this.replyActive || this.screen !== 'ready' || this.historyVisible || !this.segments.length) return;
    if ((e.target as Element | null)?.closest('a,button,[data-msk-action]')) return;
    e.stopPropagation();
    e.preventDefault();
    // 保险：清掉播放开始前（非 replying 态）遗留的选区。
    this.content.ownerDocument.getSelection()?.removeAllRanges();
    if (this.typewriter?.typing) { this.typewriter.finish(); return; }
    if (this.pageIndex < this.segments.length - 1) this.showPage(this.pageIndex + 1, true);
    else this.completeReply();
  }
  private updateHint(): void {
    const footer = this.get('.gal-footer');
    const hint = this.get('.page-hint');
    this.panel.classList.toggle('replying', this.screen === 'ready' && this.replyActive);
    const showFooter = this.screen === 'ready' && this.replyActive && this.playing;
    footer.classList.toggle('show', showFooter);
    if (!showFooter) { hint.textContent = ''; hint.classList.remove('blink'); return; }
    // 页脚计数只计文本页：指令页不展示，数进去会让「2/5」跳到看不见的页
    const total = this.segments.filter(s => !s.classList.contains('msk-cue')).length;
    const page = this.segments.slice(0, this.pageIndex + 1).filter(s => !s.classList.contains('msk-cue')).length;
    hint.classList.toggle('blink', !this.typewriter?.typing && total > 0);
    if (!total) hint.textContent = '';
    else if (this.typewriter?.typing) hint.textContent = total > 1 ? `${page}/${total}` : '';
    else if (page < total) hint.textContent = `点击继续 ${page}/${total}`;
    else hint.textContent = total > 1 ? `点击收起 ${page}/${total}` : '点击收起';
  }
  private clearPlayback(keepLock = false): void {
    if (!keepLock) this.unlockPanel();
    // 表情属于正在展示的回复：读完、收起或替换展示时释放，而非等下次发送。
    if (this.replyActive) this.controller.onCancelPerformance();
    this.replyActive = false; this.replyToken = null; this.playing = false;
    this.segments = []; this.pageIndex = 0;
    this.typewriter?.cancel(); this.typewriter = null;
    this.clearCueTimer();
  }
  /** 末页消费完毕才走这里：收起并上报已读。中途 Esc/返回/× 收起不算读完，不上报。 */
  private completeReply(): void {
    this.markSessionRead();
    this.hideReply();
  }
  /** 失败静默：未读点只是提示态，下次拉会话列表会还原真实状态。 */
  private markSessionRead(): void {
    const sessionId = this.activeSession?.id;
    if (!sessionId || !this.auth.token) return;
    void new MskClient(this.auth.token).markSessionRead(sessionId).catch(() => {});
  }
  private hideReply(): void {
    if (this.screen !== 'ready') return;
    this.historyVisible = false;
    // 锁高保留到收起动画结束：中途收起时本页文字只播了一半，立刻解锁面板会先塌一截再淡出。
    this.clearPlayback(true); this.clearRendering();
    this.hidePanelAnimated();
    this.updateLayoutMode();
  }
  private showHistory(): void {
    if (this.screen !== 'ready') return;
    this.clearPlayback(); this.clearRendering(); this.historyVisible = true; this.content.replaceChildren(); this.showPanel('记录');
    const tools = document.createElement('div'); tools.className = 'panel-tools';
    const refresh = document.createElement('button'); refresh.textContent = '刷新记录'; refresh.className = 'ghost';
    refresh.onclick = () => { void this.refreshHistory(); }; tools.append(refresh); this.content.append(tools);
    if (!this.controller.messages.length) {
      const empty = document.createElement('p'); empty.className = 'muted-note'; empty.textContent = '还没有聊天记录，说点什么吧。'; this.content.append(empty);
    }
    // 只展示最近 50 轮；被截断（本地裁掉或服务器还有更早页）时给出省略提示。
    const start = lastRoundsStart(this.controller.messages, HISTORY_ROUND_LIMIT);
    if (start > 0 || this.historyMayHaveMore) {
      const note = document.createElement('p'); note.className = 'muted-note history-truncated';
      note.textContent = `更早的对话已省略，aliya_pet 仅支持显示 ${HISTORY_ROUND_LIMIT} 轮对话`;
      this.content.append(note);
    }
    for (const message of this.controller.messages.slice(start)) {
      const article = document.createElement('article'); const label = document.createElement('small'); label.className = message.role === 'user' ? 'who-user' : 'who-aliya'; label.textContent = message.role === 'user' ? '你' : 'Aliya';
      const text = document.createElement('div'); text.className = 'message-text'; article.append(label, text); this.content.append(article); this.bindMessage(message, text);
    }
    this.animateContent('stagger');
    // 记录按时间正序追加，打开即停在最底部的最新消息。
    requestAnimationFrame(() => { this.content.scrollTop = this.content.scrollHeight; });
  }
  private async refreshHistory(): Promise<void> {
    if (!this.activeSession || this.controller.busy) return;
    const seq = this.sequence;
    try {
      const list = await new MskClient(this.auth.token).timeline(this.activeSession.id, HISTORY_FETCH_LIMIT, this.operation?.signal);
      if (seq !== this.sequence) return;
      this.historyMayHaveMore = list.length >= HISTORY_FETCH_LIMIT;
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
      if (!((platform === 'tauri' || platform === 'android') && request.action === 'navigate') && readControlRequest(this.storage)?.at === request.at) {
        this.storage?.removeItem(CONTROL_REQUEST_KEY);
      }
      if (request.action === 'deleted') {
        this.activeSession = null; this.controller.replaceHistory([]); await this.loadSessions(); return;
      }
      if (request.action === 'refresh') {
        await this.enterSession(this.activeSession); return;
      }
      if (request.action === 'replay') {
        const current = this.controller.messages.find(message => (message.messageId || message.id) === request.messageId);
        let message = current;
        if (!message) {
          const around = await new MskClient(this.auth.token).messagesAround(request.sessionId, request.messageId!, this.operation?.signal);
          const source = around.find(item => item.id === request.messageId && item.role === 'assistant');
          if (source) message = { id: source.id, messageId: source.id, role: 'assistant', text: source.content, file: source.file, status: 'complete' };
        }
        if (!message || message.role !== 'assistant') {
          this.status.textContent = '这条回复已删除，无法重新播放。';
          return;
        }
        this.setOpen(true);
        this.showReply(message);
        if (platform === 'tauri') await import('@tauri-apps/api/core').then(m => m.invoke('show_chat'));
        return;
      }
      if (platform === 'tauri') {
        await import('@tauri-apps/api/core').then(m => m.invoke('show_records'));
        return;
      }
      if (platform === 'android') { shellAction('open-records'); return; }
      const messages = await new MskClient(this.auth.token).messagesAround(request.sessionId, request.messageId!, this.operation?.signal);
      if (seq !== this.sequence) return;
      this.setOpen(true); this.showHistory(); this.clearRendering(); this.content.replaceChildren();
      const tools = document.createElement('div'); tools.className = 'panel-tools';
      const refresh = document.createElement('button'); refresh.textContent = '回到最新记录'; refresh.className = 'ghost';
      refresh.onclick = () => { void this.refreshHistory(); }; tools.append(refresh); this.content.append(tools);
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
      this.animateContent('stagger');
      if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
      else this.status.textContent = '目标消息已删除或不在可见记录中。';
    } catch (e) { if (seq === this.sequence) this.status.textContent = this.error(e); }
    finally {
      this.controlRequestActive = false;
      // 处理期间写入的新请求被入口守卫跳过，这里补消费；同一条不重复进
      // （tauri 定位键故意留给记录窗移除，at 相同即跳出，不会自旋）。
      const next = readControlRequest(this.storage);
      if (next && next.at !== request.at) void this.applyControlRequest();
    }
  }
  private error(e: unknown): string { return e instanceof Error ? e.message : '连接失败，请重试。'; }
}
