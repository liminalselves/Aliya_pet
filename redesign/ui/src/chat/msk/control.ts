import { MSK_BASE } from './config';

export const CONTROL_PANELS = {
  model: '模型', draw: '生图', proactive: '主动消息', memory: '记忆',
  worldbook: '世界书', rules: '规则', style: '对话风格', operations: '会话',
} as const;
export type ControlPanel = keyof typeof CONTROL_PANELS;
export interface ControlEvent { type: string; messageId?: string; url?: string; endpoint?: string; reason?: string; code?: string }

export const CONTROL_APPEARANCE = {
  colorScheme: 'dark', accent: '#bca5df', background: '#241f26', panel: '#2f2933',
  foreground: '#e8e2e6', muted: '#a89aa8', divider: '#4a4048', radius: '10px',
  fontFamily: '"Microsoft YaHei", system-ui, sans-serif', fontSize: '13px',
  contentMaxWidth: '860px', spacing: '12px',
};

export class AgentControlFrame {
  readonly iframe = document.createElement('iframe');
  private timer: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private authenticated = false;
  constructor(container: HTMLElement, sessionId: string, panel: ControlPanel,
    private readonly token: () => string, private readonly onEvent: (event: ControlEvent) => void) {
    this.iframe.title = `Aliya · ${CONTROL_PANELS[panel]}`;
    this.iframe.className = 'agent-control-frame';
    this.iframe.referrerPolicy = 'origin';
    this.iframe.src = `${MSK_BASE}/agents/embed/${encodeURIComponent(sessionId)}/${panel}`;
    window.addEventListener('message', this.receive);
    this.timer = setTimeout(() => this.onEvent({ type: 'misskey:agent-control:error', code: 'LOAD_TIMEOUT' }), 20_000);
    container.append(this.iframe);
  }
  private receive = (event: MessageEvent): void => {
    if (this.destroyed || event.origin !== MSK_BASE || event.source !== this.iframe.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'misskey:agent-control:ready') {
      const token = this.token();
      if (!token) { this.onEvent({ type: 'misskey:agent-control:error', code: 'AUTHENTICATION_FAILED' }); return; }
      this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:configure', token, appearance: CONTROL_APPEARANCE }, MSK_BASE);
    }
    if (message.type === 'misskey:agent-control:authenticated') { this.authenticated = true; clearTimeout(this.timer); }
    if (message.type === 'misskey:agent-control:error') { this.authenticated = false; clearTimeout(this.timer); }
    this.onEvent(message);
  };
  setToken(token: string): void {
    if (!this.destroyed) this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:update-token', token }, MSK_BASE);
  }
  setPanel(panel: ControlPanel): boolean {
    if (this.destroyed || !this.authenticated) return false;
    this.iframe.title = `Aliya · ${CONTROL_PANELS[panel]}`;
    this.iframe.contentWindow?.postMessage({ type: 'misskey:agent-control:set-panel', panel }, MSK_BASE);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    window.removeEventListener('message', this.receive);
    this.iframe.remove();
  }
}
