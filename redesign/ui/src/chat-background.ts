/**
 * 聊天背景层（跨端共用）：内置自适应动画场景 + 主题插画（chat-scenes.ts）+ 时段流转 + 用户自定义图（IndexedDB）。
 * 适用表面：Android 主界面 / Web 舞台（stage）、聊天记录页（records）、桌面端 GAL 对话面板（card）。
 * 选中项与暗化遮罩存在设置里（PetSettings.chatBackground / chatBackgroundDim）。
 */

import {
  CHAT_SCENES,
  resolveAutoScene,
  resolveChatScene,
  type ChatScene,
} from './chat-scenes';
import { isTouchDevice, platform } from './platform';

export {
  CHAT_SCENES,
  resolveAutoScene,
  resolveChatScene,
  type AutoSceneMatch,
  type ChatScene,
  type ChatSceneKind,
} from './chat-scenes';

/** 'none' = 纯色底；'auto' = 随时间流转；'custom' = 用户上传的图；其余为内置场景 id。 */
export type ChatBackgroundId = string;
export const NO_BACKGROUND = 'none';
export const AUTO_BACKGROUND = 'auto';
export const CUSTOM_BACKGROUND = 'custom';

export type ChatBackgroundSurface = 'stage' | 'records' | 'card';

export interface ChatBackgroundOptions {
  /** 挂载容器（默认 document.body；记录页传 .records-shell，桌面对话传 .gal-panel）。 */
  container?: HTMLElement;
  /** 是否将高度钉在首个视口（仅移动端舞台防软键盘挤压时需要，桌面与容器内不钉）。 */
  pinViewport?: boolean;
  /** 宿主表面角色，用于控制定位方式与可读性暗化保底。 */
  surface?: ChatBackgroundSurface;
  /** 背景激活/关闭变化回调。 */
  onActiveChange?: (active: boolean) => void;
}

const DB_NAME = 'aliya_backgrounds';
const STORE = 'images';
const CUSTOM_KEY = 'custom';
/** 自定义图按屏幕压缩：长边上限，控制存储体积与解码内存。 */
const MAX_EDGE = 2048;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 不可用'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('存储失败'));
      tx.onabort = () => reject(tx.error ?? new Error('存储失败'));
    });
  } finally {
    db.close();
  }
}

export async function loadCustomBackground(): Promise<Blob | null> {
  try {
    const value = await withStore<unknown>('readonly', s => s.get(CUSTOM_KEY));
    return value instanceof Blob ? value : null;
  } catch {
    return null;
  }
}

export async function deleteCustomBackground(): Promise<void> {
  await withStore('readwrite', s => s.delete(CUSTOM_KEY));
}

/** 压缩后保存自定义图（长边 ≤ 2048，JPEG 0.86）；解码失败抛中文错误。 */
export async function saveCustomBackground(file: Blob): Promise<Blob> {
  const blob = await compressImage(file);
  await withStore('readwrite', s => s.put(blob, CUSTOM_KEY));
  return blob;
}

async function compressImage(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try { await img.decode(); } catch { throw new Error('无法读取这张图片。'); }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('无法读取这张图片。');
    const k = Math.min(1, MAX_EDGE / Math.max(w, h));
    if (k === 1 && file.size < 1.5 * 1024 * 1024 && /^image\/(jpeg|webp)$/.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片处理失败。')), 'image/jpeg', 0.86));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 聊天背景渲染层：双槽交叉淡入，新内容（内置场景 / 插画 / 自定义图解码完成）就绪后再切换。
 *
 * 自定义图适配：object-fit:cover 铺满任意屏幕不留边；对焦点按图片与容器宽高比自动取——
 * 图比容器瘦长（要裁上下）时取 30% 高度，保住多在上半部的人物/主体；否则居中裁左右。
 */
export class ChatBackgroundLayer {
  private readonly root = document.createElement('div');
  private readonly surface: ChatBackgroundSurface;
  private readonly onActiveChange?: (active: boolean) => void;
  private slots: HTMLElement[] = [];
  private front = 0;
  private current = '';
  private requestedId: ChatBackgroundId = NO_BACKGROUND;
  private lastDim = 0.35;
  private objectUrl: string | null = null;
  private token = 0;
  private still = false;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onResize: (() => void) | null = null;

  constructor(options: ChatBackgroundOptions = {}) {
    this.surface = options.surface ?? 'stage';
    this.onActiveChange = options.onActiveChange;
    this.root.className = 'chat-bg';
    this.root.dataset.surface = this.surface;
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) {
      const slot = document.createElement('div');
      slot.className = 'chat-bg-slot';
      this.slots.push(slot);
      this.root.append(slot);
    }
    const dim = document.createElement('div');
    dim.className = 'chat-bg-dim';
    this.root.append(dim);

    const mount = options.container ?? document.body;
    mount.prepend(this.root);

    const shouldPin = options.pinViewport ?? (this.surface === 'stage' && (platform === 'android' || isTouchDevice));
    if (shouldPin) {
      // 钉住首个视口高度：移动端软键盘弹出 WebView 变矮时背景不被挤压拉伸。
      const pin = () => { this.root.style.height = `${window.innerHeight}px`; };
      let lastWidth = window.innerWidth;
      pin();
      this.onResize = () => {
        if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; pin(); this.refocus(); }
        else if (window.innerHeight > parseFloat(this.root.style.height || '0')) pin();
      };
      window.addEventListener('resize', this.onResize);
    } else {
      this.onResize = () => this.refocus();
      window.addEventListener('resize', this.onResize);
    }
  }

  /** 省电模式/暂停渲染时冻结场景动画（只停 CSS 动画，不改画面）。 */
  setStill(still: boolean): void {
    this.still = still;
    for (const slot of this.slots) slot.querySelector('.bg-scene')?.classList.toggle('still', still);
  }

  /** 处于「随时间流转」模式时按当前时刻重新匹配，若跨时段则平滑切换。 */
  refreshAuto(now: Date = new Date()): void {
    if (this.requestedId === AUTO_BACKGROUND) {
      void this.apply(AUTO_BACKGROUND, this.lastDim, now);
    }
  }

  async apply(id: ChatBackgroundId, dim: number, now: Date = new Date()): Promise<void> {
    this.requestedId = id;
    this.lastDim = dim;
    this.root.style.setProperty('--bg-dim', String(Math.min(0.8, Math.max(0, dim))));
    this.syncAutoTimer(id === AUTO_BACKGROUND);

    const token = ++this.token;
    const scene: ChatScene | null = resolveChatScene(id, now);
    let url = '';
    let objectUrl: string | null = null;
    if (id === CUSTOM_BACKGROUND) {
      const blob = await loadCustomBackground();
      if (token !== this.token) return;
      if (blob) { objectUrl = URL.createObjectURL(blob); url = objectUrl; }
    }
    // 自定义图每次都重读（换图后 rev 变化才会调用到这里）；场景同 id 不重建。
    const key = scene ? `scene:${scene.id}` : url ? 'custom' : '';
    if (key === this.current && key !== 'custom') return;
    if (!key) {
      this.current = '';
      for (const slot of this.slots) slot.classList.remove('shown');
      this.root.classList.remove('active');
      this.onActiveChange?.(false);
      this.swapObjectUrl(null);
      this.clearHidden();
      return;
    }
    const next = this.slots[1 - this.front]!;
    next.replaceChildren();
    if (scene) {
      const el = scene.build();
      el.classList.toggle('still', this.still);
      next.append(el);
      const illusImg = el.querySelector<HTMLImageElement>('.illus-img');
      if (illusImg) {
        try { await illusImg.decode(); } catch { /* 解码失败仍照常过渡 */ }
        if (token !== this.token) return;
      }
    } else {
      const img = document.createElement('img');
      img.className = 'chat-bg-img';
      img.alt = ''; img.draggable = false; img.decoding = 'async'; img.src = url;
      next.append(img);
      try { await img.decode(); } catch { /* 解码失败也照常切换，避免卡在旧图 */ }
      if (token !== this.token) { URL.revokeObjectURL(url); return; }
      this.focus(img);
    }
    this.current = key;
    this.root.classList.add('active');
    this.onActiveChange?.(true);
    next.classList.add('shown');
    this.slots[this.front]!.classList.remove('shown');
    this.front = 1 - this.front;
    this.swapObjectUrl(objectUrl);
    this.clearHidden();
  }

  destroy(): void {
    this.syncAutoTimer(false);
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.swapObjectUrl(null);
    this.root.remove();
  }

  private syncAutoTimer(enabled: boolean): void {
    if (enabled && this.autoTimer === null) {
      this.autoTimer = setInterval(() => this.refreshAuto(), 60_000);
    } else if (!enabled && this.autoTimer !== null) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }

  /** 对焦点：竖图（比容器更瘦长）上移到 30%，其余居中。 */
  private focus(img: HTMLImageElement): void {
    const imgRatio = img.naturalWidth / Math.max(1, img.naturalHeight);
    const rect = this.root.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || parseFloat(this.root.style.height) || window.innerHeight;
    const viewRatio = w / Math.max(1, h);
    img.style.objectPosition = imgRatio < viewRatio ? '50% 30%' : '50% 50%';
  }

  private refocus(): void {
    const img = this.slots[this.front]?.querySelector<HTMLImageElement>('.chat-bg-img');
    if (img?.naturalWidth) this.focus(img);
  }

  /** 淡出结束后清空背面槽，场景动画与解码位图不在看不见的层里常驻。 */
  private clearHidden(): void {
    const token = this.token;
    setTimeout(() => {
      if (token !== this.token) return;
      for (const slot of this.slots) if (!slot.classList.contains('shown')) slot.replaceChildren();
    }, 600);
  }

  /** 旧自定义图的 objectURL 等淡出结束再释放。 */
  private swapObjectUrl(next: string | null): void {
    const old = this.objectUrl;
    this.objectUrl = next;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 600);
  }
}
