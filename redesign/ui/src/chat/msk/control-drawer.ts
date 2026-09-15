import { AgentControlFrame, CONTROL_PANELS, type ControlPanel, type ControlEvent } from './control';
import { MSK_BASE, MSK_TOKEN_KEY, MSK_USER_KEY, mskSessionKey } from './config';
import { CONTROL_REQUEST_KEY, type ControlRequest } from './control-bridge';
import { MskClient } from './client';
import { openUrl } from '../../platform';
import './control.css';

export function mountAgentControls(container: HTMLElement, openChat: () => Promise<void>, refreshSummary: () => void): void {
  const button = document.createElement('button');
  button.className = 'act wide'; button.textContent = '配置当前会话';
  container.append(button);
  const drawer = document.createElement('dialog'); drawer.className = 'agent-control-drawer';
  drawer.innerHTML = `<header><div><small>ALIYA</small><h2>会话配置</h2><p class="control-session"></p></div><button class="control-close" aria-label="关闭会话配置">×</button></header>
    <nav aria-label="会话配置面板"></nav><div class="control-status" role="status"></div><button class="control-retry" hidden>重新加载</button><div class="control-body"></div>`;
  document.body.append(drawer);
  const status = drawer.querySelector<HTMLElement>('.control-status')!;
  const retry = drawer.querySelector<HTMLButtonElement>('.control-retry')!;
  const body = drawer.querySelector<HTMLElement>('.control-body')!;
  const nav = drawer.querySelector<HTMLElement>('nav')!;
  let frame: AgentControlFrame | null = null;
  let panel: ControlPanel = 'model';
  let sessionId = '';
  let userId = '';
  let credential = '';
  let revision = 0;
  const saved = () => {
    try {
      const token = localStorage.getItem(MSK_TOKEN_KEY) ?? '';
      const user = JSON.parse(localStorage.getItem(MSK_USER_KEY) ?? 'null');
      const session = user?.id ? JSON.parse(localStorage.getItem(mskSessionKey(user.id)) ?? 'null') : null;
      return { token, userId: String(user?.id ?? ''), id: String(session?.id ?? ''), name: String(session?.name ?? 'Aliya') };
    } catch { return { token: '', userId: '', id: '', name: 'Aliya' }; }
  };
  const sync = () => {
    const current = saved();
    button.disabled = !current.token || !current.id;
    button.title = button.disabled ? '请先在聊天中连接账号并选择会话' : '';
    if (!drawer.open) return;
    if (current.id !== sessionId || current.userId !== userId || !current.token) { drawer.close(); return; }
    if (credential !== current.token) { credential = current.token; frame?.setToken(credential); }
  };
  const publish = async (action: ControlRequest['action'], message?: ControlEvent) => {
    const request: ControlRequest = { action, sessionId, at: Date.now() };
    if (message) { request.messageId = message.messageId; request.divider = message.type.endsWith('navigate-context-divider'); }
    localStorage.setItem(CONTROL_REQUEST_KEY, JSON.stringify(request));
    if (action === 'navigate') await openChat();
  };
  const refresh = async () => {
    const currentRevision = ++revision;
    const current = saved();
    try {
      const detail = await new MskClient(current.token).post<{ name?: string }>('/agents/sessions/show', { sessionId });
      if (!drawer.open || revision !== currentRevision || saved().id !== current.id) return;
      const name = detail.name || 'Aliya';
      localStorage.setItem(mskSessionKey(current.userId), JSON.stringify({ id: sessionId, name }));
      drawer.querySelector('.control-session')!.textContent = name;
      refreshSummary();
      await publish('refresh');
    } catch { if (drawer.open && revision === currentRevision) status.textContent = '配置已保存，但会话信息刷新失败。'; }
  };
  const onEvent = (event: ControlEvent) => {
    if (!drawer.open) return;
    if (event.type === 'misskey:agent-control:authenticated') { status.textContent = ''; retry.hidden = true; }
    if (event.type === 'misskey:agent-control:error') {
      status.textContent = event.code === 'AUTHENTICATION_FAILED' ? '连接已失效，请回聊天重新授权。' : '配置页未能加载，请确认 Misskey 已启动并支持托管控制台。';
      retry.hidden = false;
    }
    if (event.type === 'misskey:agent-control:api-success' && typeof event.endpoint === 'string'
      && /\/(update|add|import|import-context|rollback|set-status)$/.test(event.endpoint)) void refresh();
    if (event.type === 'misskey:agent-control:open-url' && typeof event.url === 'string') {
      try { const url = new URL(event.url, MSK_BASE); if (['http:', 'https:'].includes(url.protocol)) void openUrl(url.href); } catch { /* Ignore malformed navigation. */ }
    }
    if (['misskey:agent-control:navigate-message', 'misskey:agent-control:navigate-context-divider'].includes(event.type) && typeof event.messageId === 'string') {
      void publish('navigate', event).catch(() => { status.textContent = '无法打开聊天记录。'; });
    }
    if (event.type === 'misskey:agent-control:close-requested') {
      if (event.reason === 'session-deleted') {
        void publish('deleted').catch(() => {});
        localStorage.removeItem(mskSessionKey(userId));
      }
      drawer.close(); refreshSummary(); sync();
    }
  };
  const load = () => {
    frame?.destroy(); status.textContent = '正在连接配置页…'; retry.hidden = true;
    nav.querySelectorAll<HTMLButtonElement>('button').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.panel === panel)));
    frame = new AgentControlFrame(body, sessionId, panel, () => saved().token, onEvent);
  };
  for (const [id, label] of Object.entries(CONTROL_PANELS)) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = label; tab.dataset.panel = id;
    tab.onclick = () => { panel = id as ControlPanel; load(); }; nav.append(tab);
  }
  retry.onclick = load;
  drawer.querySelector<HTMLButtonElement>('.control-close')!.onclick = () => drawer.close();
  drawer.addEventListener('close', () => { ++revision; frame?.destroy(); frame = null; button.focus(); });
  button.onclick = () => {
    const current = saved(); if (!current.token || !current.id) { sync(); return; }
    sessionId = current.id; userId = current.userId; credential = current.token;
    drawer.querySelector('.control-session')!.textContent = current.name;
    drawer.showModal(); load();
  };
  window.addEventListener('storage', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('pagehide', () => frame?.destroy());
  sync();
}
