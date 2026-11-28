import { AgentControlFrame, CONTROL_PANELS, preconnectMskOrigin, type ControlPanel, type ControlEvent } from './control';
import { MSK_BASE, MSK_TOKEN_KEY, MSK_USER_KEY, mskSessionKey } from './config';
import { CONTROL_REQUEST_KEY, type ControlRequest } from './control-bridge';
import { MskClient } from './client';
import { openUrl, platform } from '../../platform';
import { showToast } from '../../toast';
import './control.css';

export interface AgentControlHandle {
  open(): void;
  close(): void;
  sync(): void;
  warm(): void;
}

export function mountAgentControls(container: HTMLElement, openRecords: () => Promise<void>, refreshSummary: () => void): AgentControlHandle {
  preconnectMskOrigin();
  const button = document.createElement('button');
  button.className = 'act wide'; button.textContent = '配置当前会话';
  container.append(button);
  const drawer = document.createElement('dialog'); drawer.className = 'agent-control-drawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `<header><div><small>ALIYA</small><h2>会话配置</h2><p class="control-session"></p></div><div class="control-actions"><button type="button" class="control-reload" aria-label="重新加载配置页" title="重新加载"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.35-3.42M13 3.2v2.4h-2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="control-close" aria-label="关闭会话配置"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div></header>
    <nav aria-label="会话配置面板"></nav><div class="control-status" role="status"></div><button class="control-retry" hidden>重新加载</button><div class="control-body"></div>`;
  document.body.append(drawer);
  const status = drawer.querySelector<HTMLElement>('.control-status')!;
  const retry = drawer.querySelector<HTMLButtonElement>('.control-retry')!;
  const body = drawer.querySelector<HTMLElement>('.control-body')!;
  const nav = drawer.querySelector<HTMLElement>('nav')!;
  let frame: AgentControlFrame | null = null;
  let frameSessionId = '';
  let frameUserId = '';
  let panel: ControlPanel = 'model';
  let sessionId = '';
  let userId = '';
  let credential = '';
  let revision = 0;
  let closeTimer = 0;
  let warmTimer = 0;
  let lastAutoWarmKey = '';
  let initialWarmDone = false;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 统一出口：先播退出动画（control.css .closing）再真正 close，重开/重按幂等。 */
  const closeDrawer = () => {
    if (!drawer.open || drawer.classList.contains('closing')) return;
    if (reducedMotion()) { drawer.close(); return; }
    drawer.classList.add('closing');
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      drawer.classList.remove('closing');
      drawer.close();
    }, 160);
  };
  const cancelClose = () => {
    if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = 0; }
    drawer.classList.remove('closing');
  };
  const saved = () => {
    try {
      const token = localStorage.getItem(MSK_TOKEN_KEY) ?? '';
      const user = JSON.parse(localStorage.getItem(MSK_USER_KEY) ?? 'null');
      const session = user?.id ? JSON.parse(localStorage.getItem(mskSessionKey(user.id)) ?? 'null') : null;
      return {
        token,
        userId: String(user?.id ?? ''),
        id: String(session?.id ?? ''),
        name: String(session?.name ?? 'Aliya'),
        characterId: String(session?.characterId ?? ''),
        characterName: String(session?.characterName ?? 'Aliya'),
      };
    } catch { return { token: '', userId: '', id: '', name: 'Aliya', characterId: '', characterName: 'Aliya' }; }
  };
  const cancelWarm = () => {
    if (warmTimer) { window.clearTimeout(warmTimer); warmTimer = 0; }
  };
  const destroyFrame = () => {
    cancelWarm();
    frame?.destroy();
    frame = null;
    frameSessionId = '';
    frameUserId = '';
    drawer.classList.remove('warm');
  };
  const matchesCurrentFrame = (current: ReturnType<typeof saved>) =>
    Boolean(frame && !frame.hasError && frame.status !== 'destroyed'
      && current.token && current.id && current.userId
      && current.id === frameSessionId && current.userId === frameUserId);
  const sync = () => {
    const current = saved();
    button.disabled = !current.token || !current.id;
    button.title = button.disabled ? '请先在聊天中连接账号并选择会话' : '';
    const stale = Boolean(frame) && (!current.token || !current.id || current.id !== frameSessionId || current.userId !== frameUserId);
    if (drawer.open) {
      if (!current.token || !current.id || current.id !== sessionId || current.userId !== userId) {
        destroyFrame();
        closeDrawer();
        return;
      }
      if (credential !== current.token) { credential = current.token; frame?.setToken(credential); }
      return;
    }
    if (stale) {
      destroyFrame();
      lastAutoWarmKey = '';
    } else if (frame && current.token && credential !== current.token) {
      credential = current.token;
      frame.setToken(credential);
    }
    if (!current.token || !current.id || !current.userId) {
      cancelWarm();
      lastAutoWarmKey = '';
      return;
    }
    const key = `${current.userId}:${current.id}`;
    if (!frame && !warmTimer && lastAutoWarmKey !== key) {
      const delay = !initialWarmDone
        ? (platform === 'tauri' ? 2500 : platform === 'android' ? 400 : 1200)
        : (platform === 'tauri' ? 800 : 400);
      initialWarmDone = true;
      lastAutoWarmKey = key;
      warmTimer = window.setTimeout(() => { warmTimer = 0; warm(); }, delay);
    }
  };
  const publish = async (action: ControlRequest['action'], message?: ControlEvent) => {
    const request: ControlRequest = { action, sessionId, at: Date.now() };
    if (message) { request.messageId = message.messageId; request.divider = message.type.endsWith('navigate-context-divider'); }
    localStorage.setItem(CONTROL_REQUEST_KEY, JSON.stringify(request));
    if (action === 'navigate') await openRecords();
  };
  const refresh = async () => {
    const currentRevision = ++revision;
    const current = saved();
    try {
      const detail = await new MskClient(current.token).post<{ name?: string }>('/agents/sessions/show', { sessionId });
      if (!drawer.open || revision !== currentRevision || saved().id !== current.id) return;
      const name = detail.name || 'Aliya';
      const previous = saved();
      localStorage.setItem(mskSessionKey(current.userId), JSON.stringify({
        id: sessionId,
        name,
        characterId: previous.characterId,
        characterName: previous.characterName,
      }));
      drawer.querySelector('.control-session')!.textContent = name;
      refreshSummary();
      await publish('refresh');
    } catch { if (drawer.open && revision === currentRevision) showToast('配置已保存，但会话信息刷新失败。', { kind: 'error' }); }
  };
  const onEvent = (event: ControlEvent) => {
    if (event.type === 'misskey:agent-control:authenticated') {
      if (frame && frame.currentPanel !== panel) frame.setPanel(panel);
      status.textContent = ''; status.className = 'control-status'; retry.hidden = true;
      return;
    }
    if (event.type === 'misskey:agent-control:error') {
      // 后台预热失败静默丢弃，待用户真正打开抽屉时再全新连接，不提前暴露错误。
      if (!drawer.open) { destroyFrame(); return; }
      status.className = 'control-status error';
      status.textContent = event.code === 'AUTHENTICATION_FAILED' ? '连接已失效，请回聊天重新授权。' : '配置页未能加载，请确认 Misskey 已启动并支持托管控制台。';
      retry.hidden = false;
      return;
    }
    if (event.type === 'misskey:agent-control:close-requested') {
      if (event.reason === 'session-deleted') {
        const deletedUser = userId || frameUserId;
        destroyFrame();
        if (drawer.open) void publish('deleted').catch(() => {});
        if (deletedUser) localStorage.removeItem(mskSessionKey(deletedUser));
      }
      closeDrawer(); refreshSummary(); sync();
      return;
    }
    if (!drawer.open) return;
    if (event.type === 'misskey:agent-control:api-success' && typeof event.endpoint === 'string'
      && /\/(update|add|import|import-context|rollback|set-status)$/.test(event.endpoint)) void refresh();
    if (event.type === 'misskey:agent-control:open-url' && typeof event.url === 'string') {
      try { const url = new URL(event.url, MSK_BASE); if (['http:', 'https:'].includes(url.protocol)) void openUrl(url.href); } catch { /* Ignore malformed navigation. */ }
    }
    if (['misskey:agent-control:navigate-message', 'misskey:agent-control:navigate-context-divider'].includes(event.type) && typeof event.messageId === 'string') {
      void publish('navigate', event).catch(() => { showToast('无法打开聊天记录。', { kind: 'error' }); });
    }
  };
  const activate = () => {
    let active: HTMLButtonElement | null = null;
    nav.querySelectorAll<HTMLButtonElement>('button').forEach(tab => {
      const on = tab.dataset.panel === panel;
      tab.setAttribute('aria-pressed', String(on));
      if (on) active = tab;
    });
    if (active) revealTab(active);
  };
  /** 选中页签滚进可视区（两侧各留 24px 渐隐余量）；只动 nav 自身，不牵动对话框纵向滚动。 */
  const revealTab = (tab: HTMLElement) => {
    const pad = 24;
    const left = tab.offsetLeft - nav.offsetLeft;
    const target = left < nav.scrollLeft + pad ? left - pad
      : left + tab.offsetWidth > nav.scrollLeft + nav.clientWidth - pad ? left + tab.offsetWidth - nav.clientWidth + pad : null;
    if (target !== null) nav.scrollTo({ left: Math.max(0, target), behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  /** 两侧有隐藏页签时挂 more-left/more-right，CSS 用遮罩渐隐边缘示意可滑动。 */
  const syncNavEdges = () => {
    const max = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('more-left', nav.scrollLeft > 1);
    nav.classList.toggle('more-right', max - nav.scrollLeft > 1);
  };
  /** 内容区淡入重触发（control.css .swap）：切页签/重载共用。 */
  const swapBody = () => {
    body.classList.remove('swap');
    void body.offsetWidth;
    body.classList.add('swap');
  };
  const startFrame = (target: ReturnType<typeof saved>, silent: boolean) => {
    cancelWarm();
    frame?.destroy();
    frame = null;
    frameSessionId = target.id;
    frameUserId = target.userId;
    credential = target.token;
    drawer.classList.add('warm');
    if (!silent) {
      status.textContent = '正在连接配置页'; status.className = 'control-status loading'; retry.hidden = true;
      activate(); swapBody();
    }
    frame = new AgentControlFrame(body, target.id, panel, () => saved().token, onEvent);
  };
  const load = () => {
    const current = saved();
    if (!current.token || !current.id || !current.userId) { destroyFrame(); closeDrawer(); sync(); return; }
    sessionId = current.id;
    userId = current.userId;
    startFrame(current, false);
  };
  const warm = () => {
    cancelWarm();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const current = saved();
    if (!current.token || !current.id || !current.userId) return;
    lastAutoWarmKey = `${current.userId}:${current.id}`;
    if (matchesCurrentFrame(current)) {
      if (credential !== current.token) { credential = current.token; frame!.setToken(credential); }
      return;
    }
    startFrame(current, !drawer.open);
  };
  for (const [id, label] of Object.entries(CONTROL_PANELS)) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = label; tab.dataset.panel = id;
    tab.onclick = () => {
      if (panel === id) return;
      panel = id as ControlPanel;
      if (frame?.setPanel(panel)) {
        activate(); swapBody();
      } else if (frame?.isLoading && frameSessionId === sessionId && frameUserId === userId) {
        // 连接进行中切页签不销毁重连，认证完成后立即经 setPanel 切过去。
        activate();
      } else {
        load();
      }
    };
    nav.append(tab);
  }
  // 页签条隐藏了滚动条：触屏/触控板原生横滑可用，鼠标另补滚轮与拖动两条路径。
  nav.addEventListener('scroll', syncNavEdges, { passive: true });
  new ResizeObserver(syncNavEdges).observe(nav);
  nav.addEventListener('wheel', e => {
    if (nav.scrollWidth <= nav.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    nav.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  }, { passive: false });
  let drag: { id: number; x: number; left: number; moved: boolean } | null = null;
  nav.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || nav.scrollWidth <= nav.clientWidth) return;
    drag = { id: e.pointerId, x: e.clientX, left: nav.scrollLeft, moved: false };
  });
  nav.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) { drag.moved = true; nav.setPointerCapture(e.pointerId); nav.classList.add('dragging'); }
    nav.scrollLeft = drag.left - dx;
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved; drag = null;
    nav.classList.remove('dragging');
    // 拖动结束时松手位置的页签会收到 click，拦下避免误切。
    if (moved && e.type === 'pointerup') nav.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
  };
  nav.addEventListener('pointerup', endDrag);
  nav.addEventListener('pointercancel', endDrag);
  retry.onclick = load;
  drawer.querySelector<HTMLButtonElement>('.control-reload')!.onclick = load;
  drawer.querySelector<HTMLButtonElement>('.control-close')!.onclick = () => closeDrawer();
  // Esc 触发 cancel：拦下默认立即 close，走退出动画。
  drawer.addEventListener('cancel', e => { e.preventDefault(); closeDrawer(); });
  drawer.addEventListener('close', () => {
    cancelClose();
    ++revision;
    if (frame?.hasError) destroyFrame();
    drawer.setAttribute('aria-hidden', 'true');
    button.focus();
  });
  const open = () => {
    const current = saved(); if (!current.token || !current.id) { destroyFrame(); sync(); button.focus(); return; }
    cancelClose();
    cancelWarm();
    sessionId = current.id; userId = current.userId;
    drawer.querySelector('.control-session')!.textContent = current.name;
    drawer.removeAttribute('aria-hidden');
    if (!drawer.open) drawer.showModal();
    if (matchesCurrentFrame(current)) {
      if (credential !== current.token) { credential = current.token; frame!.setToken(credential); }
      if (frame!.isAuthenticated) {
        if (frame!.currentPanel !== panel) frame!.setPanel(panel);
        status.textContent = ''; status.className = 'control-status'; retry.hidden = true;
        activate();
      } else {
        frame!.refreshTimeout();
        status.textContent = '正在连接配置页'; status.className = 'control-status loading'; retry.hidden = true;
        activate();
      }
    } else {
      load();
    }
    syncNavEdges();
  };
  button.onclick = open;
  button.addEventListener('pointerenter', warm);
  button.addEventListener('focus', warm);
  window.addEventListener('storage', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('pagehide', destroyFrame);
  sync();
  return { open, close: closeDrawer, sync, warm };
}
