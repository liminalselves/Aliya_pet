import { MSK_BASE } from './config';

export const CONTROL_PANELS = {
  model: '模型', draw: '生图', proactive: '主动消息', memory: '记忆',
  worldbook: '世界书', rules: '规则', style: '对话风格', operations: '会话',
} as const;
export type ControlPanel = keyof typeof CONTROL_PANELS;
export interface ControlEvent { type: string; messageId?: string; url?: string; endpoint?: string; reason?: string; code?: string }

export const CONTROL_APPEARANCE = {
  colorScheme: 'dark', accent: '#e29ba3', background: '#141312', panel: '#211f1e',
  foreground: '#f2eeea', muted: '#bab3ac', divider: 'rgba(255,246,236,0.07)', radius: '12px',
  fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif', fontSize: '13px',
  contentMaxWidth: '860px', spacing: '12px',
};

export type ControlFrameState = 'loading' | 'authenticated' | 'error' | 'destroyed';

let preconnectedOrigin = '';

/** 提前预热 MSK 源的 DNS/TCP/TLS（无 crossorigin 覆盖 iframe 导航池，crossorigin 覆盖 API fetch 池）。 */
export function preconnectMskOrigin(): void {
  if (typeof document === 'undefined' || !document.head || preconnectedOrigin === MSK_BASE) return;
  preconnectedOrigin = MSK_BASE;
  const specs: Array<{ rel: string; crossOrigin?: string }> = [
    { rel: 'dns-prefetch' },
    { rel: 'preconnect' },
    { rel: 'preconnect', crossOrigin: 'anonymous' },
  ];
  for (const spec of specs) {
    const link = document.createElement('link');
    link.rel = spec.rel;
    link.href = MSK_BASE;
    if (spec.crossOrigin) link.crossOrigin = spec.crossOrigin;
    document.head.append(link);
  }
}

export class AgentControlFrame {
  readonly iframe = document.createElement('iframe');
  readonly sessionId: string;
  private panel: ControlPanel;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: ControlFrameState = 'loading';
  constructor(container: HTMLElement, sessionId: string, panel: ControlPanel,
    private readonly token: () => string, private readonly onEvent: (event: ControlEvent) => void) {
    this.sessionId = sessionId;
    this.panel = panel;
    this.iframe.title = `Aliya · ${CONTROL_PANELS[panel]}`;
    this.iframe.className = 'agent-control-frame';
    this.iframe.referrerPolicy = 'origin';
    this.iframe.src = `${MSK_BASE}/agents/embed/${encodeURIComponent(sessionId)}/${panel}`;
    window.addEventListener('message', this.receive);
    this.startTimer();
    container.append(this.iframe);
  }
  get currentPanel(): ControlPanel { return this.panel; }
  get status(): ControlFrameState { return this.state; }
  get isAuthenticated(): boolean { return this.state === 'authenticated'; }
  get isLoading(): boolean { return this.state === 'loading'; }
  get hasError(): boolean { return this.state === 'error'; }
  private startTimer(ms = 20_000): void {
    clearTimeout(this.timer);
    if (this.state !== 'loading') return;
    this.timer = setTimeout(() => {
      if (this.state !== 'loading') return;
      this.state = 'error';
      this.onEvent({ type: 'misskey:agent-control:error', code: 'LOAD_TIMEOUT' });
    }, ms);
  }
  refreshTimeout(ms = 20_000): void {
    if (this.state === 'loading') this.startTimer(ms);
  }
  private receive = (event: MessageEvent): void => {
    if (this.state === 'destroyed' || event.origin !== MSK_BASE || event.source !== this.iframe.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'misskey:agent-control:ready') {
      const token = this.token();
      if (!token) {
        this.state = 'error';
        clearTimeout(this.timer);
        this.onEvent({ type: 'misskey:agent-control:error', code: 'AUTHENTICATION_FAILED' });
        return;
      }
      const isAndroid = typeof document !== 'undefined' && document.body?.classList?.contains?.('platform-android');
      const appearance = isAndroid ? { ...CONTROL_APPEARANCE, fontSize: '15px' } : CONTROL_APPEARANCE;
      this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:configure', token, appearance }, MSK_BASE);
    }
    if (message.type === 'misskey:agent-control:authenticated') { this.state = 'authenticated'; clearTimeout(this.timer); this.iframe.classList.add('ready'); }
    if (message.type === 'misskey:agent-control:error') { this.state = 'error'; clearTimeout(this.timer); }
    this.onEvent(message);
  };
  setToken(token: string): void {
    if (this.state !== 'destroyed') this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:update-token', token }, MSK_BASE);
  }
  setPanel(panel: ControlPanel): boolean {
    if (this.state !== 'authenticated') return false;
    this.panel = panel;
    this.iframe.title = `Aliya · ${CONTROL_PANELS[panel]}`;
    this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:set-panel', panel }, MSK_BASE);
    return true;
  }
  destroy(): void {
    this.state = 'destroyed';
    clearTimeout(this.timer);
    window.removeEventListener('message', this.receive);
    this.iframe.remove();
  }
}
