/**
 * 统一轻提示：所有表面（设置、记录、聊天外的 Web 页，桌面与 Android 同一份）的短暂反馈都走这里。
 * 同一时刻只显示一条，新提示直接顶替旧提示；相同文案重复触发只重新计时。
 * 持续性状态（加载中、需要用户处理的错误）不属于轻提示，仍在各自界面内就地显示。
 */
import './styles/toast.css';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** 停留毫秒数；默认成功/普通 2400，错误 4200（含读完时间）。 */
  duration?: number;
}

const DEFAULT_DURATION: Record<ToastKind, number> = { info: 2400, success: 2400, error: 4200 };
const EXIT_MS = 150;

let el: HTMLElement | null = null;
let text: HTMLElement | null = null;
let hideTimer = 0;
let removeTimer = 0;

function ensure(): { root: HTMLElement; label: HTMLElement } {
  if (el && text && el.isConnected) return { root: el, label: text };
  const root = document.createElement('div');
  root.className = 'al-toast';
  const dot = document.createElement('i');
  dot.className = 'al-toast-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'al-toast-text';
  root.append(dot, label);
  document.body.append(root);
  el = root;
  text = label;
  return { root, label };
}

export function hideToast(): void {
  window.clearTimeout(hideTimer);
  if (!el) return;
  const root = el;
  root.classList.remove('in');
  root.classList.add('out');
  window.clearTimeout(removeTimer);
  removeTimer = window.setTimeout(() => {
    if (root.classList.contains('out')) root.remove();
    if (el === root && !root.isConnected) { el = null; text = null; }
  }, EXIT_MS);
}

export function showToast(message: string, options: ToastOptions = {}): void {
  if (!message) { hideToast(); return; }
  const kind = options.kind ?? 'info';
  const { root, label } = ensure();
  window.clearTimeout(hideTimer);
  window.clearTimeout(removeTimer);
  const same = root.classList.contains('in') && label.textContent === message && root.dataset.kind === kind;
  label.textContent = message;
  root.dataset.kind = kind;
  // 错误用 alert 立即播报，其余用 status 礼貌播报。
  root.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  if (!same) {
    // 重放入场动画：先移除再强制 reflow，连续触发也会有反馈。
    root.classList.remove('in', 'out');
    void root.offsetWidth;
    root.classList.add('in');
  }
  hideTimer = window.setTimeout(hideToast, options.duration ?? DEFAULT_DURATION[kind]);
}
