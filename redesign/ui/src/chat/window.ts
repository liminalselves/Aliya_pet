import { ChatController } from './controller';
import { ChatView } from './view';
import { MskAuth } from './msk/auth';
import { platform } from '../platform';

const disconnected = { label: '未连接', async *reply(): AsyncGenerator<never> { throw new Error('请先连接 Misskey。'); } };
// 独立原生窗口由 pet 按钮控制显隐，不显示 ChatView 内嵌模式自带的备用入口。
document.body.classList.add('chat-window');
const controller = new ChatController(disconnected);
let storage: Storage | undefined;
try { storage = localStorage; } catch { /* In-memory login remains available. */ }
const view = new ChatView(controller, new MskAuth(storage), () => {}, storage);
view.setOpen(true);
if (platform === 'tauri') {
  const { invoke } = await import('@tauri-apps/api/core');
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  // 原生窗口开关是权威状态：× 会让 ChatView 进入关闭态，下一次原生 show
  // 必须同步恢复，否则只会露出内嵌模式的备用小按钮。
  // chat-state 会随 busy/typing 变化全量重播，只在 open 跳变时动作；
  // 窗口重现时视图本就在打开态（boot 已 setOpen(true)），走 playEnter 补入场动画。
  let windowOpen = false;
  await listen<{ open: boolean }>('chat-state', e => {
    if (e.payload.open === windowOpen) return;
    windowOpen = e.payload.open;
    if (view.isOpen !== e.payload.open) view.setOpen(e.payload.open);
    else if (e.payload.open) view.playEnter();
  });
  // 表演提示经壳广播（chat-cue 全局事件），保证 pet 即使未聚焦也能收到。
  controller.onCue = cue => { void invoke('send_chat_cue', { cue }).catch(() => {}); };
  controller.onCancelPerformance = () => { void emitTo('pet', 'chat-cancel', {}); };
  startHitMaskRelay();
}

/**
 * 透明区点击穿透：把 GAL 面板与输入框的矩形栅格化为命中掩码上报给壳，
 * 面板外的透明区域点击穿透到下层窗口（chat 外窗高度固定，面板上方的透明区覆盖着 pet）。
 * 面板显隐/伸缩由 ResizeObserver 即时触发，另以 500ms 轮询兜底窗口移动与 DPI 变化；几何未变不发送。
 */
function startHitMaskRelay(): void {
  const COLS = 64;
  let lastKey = '';
  let pending = false;
  const relay = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    // 物理尺寸取原生外窗：页面可能被壳 set_zoom 缩放，innerWidth × scaleFactor 不再等于窗口像素。
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rects: DOMRect[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.gal-panel, .chat-composer')) {
      if (el.offsetParent === null) continue; // hidden 或不可见
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push(r);
    }
    const key = JSON.stringify([pos.x, pos.y, size.width, size.height, w, h, rects.map(r => [r.left | 0, r.top | 0, r.width | 0, r.height | 0])]);
    if (key === lastKey) return;
    lastKey = key;
    const rows = Math.max(1, Math.round((COLS * h) / Math.max(1, w)));
    const data = new Uint8Array(COLS * rows);
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor((r.left / w) * COLS));
      const x1 = Math.min(COLS - 1, Math.floor((r.right / w) * COLS));
      const y0 = Math.max(0, Math.floor((r.top / h) * rows));
      const y1 = Math.min(rows - 1, Math.floor((r.bottom / h) * rows));
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) data[gy * COLS + gx] = 1;
    }
    const { invoke: call } = await import('@tauri-apps/api/core');
    await call('update_hit_mask', {
      label: 'chat', cols: COLS, rows, data: Array.from(data),
      interacting: false, sticky: true,
      winX: pos.x, winY: pos.y,
      winW: size.width, winH: size.height,
    }).catch(() => {});
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; void relay(); });
  };
  const observer = new ResizeObserver(schedule);
  for (const el of document.querySelectorAll<HTMLElement>('.gal-panel, .chat-composer')) observer.observe(el);
  setInterval(schedule, 500);
}
