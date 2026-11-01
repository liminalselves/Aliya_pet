/**
 * Android 主界面聊天背景：内置动画场景（chat-scenes.ts）+ 用户自定义图（存 IndexedDB，主界面与设置页同源共享）。
 * 选中项与遮罩强度存在设置里（PetSettings.chatBackground / chatBackgroundDim）。
 */

import { CHAT_SCENES } from './chat-scenes';
export { CHAT_SCENES } from './chat-scenes';

/** 'none' = 纯色底；'custom' = 用户上传的图；其余为内置场景 id。 */
export type ChatBackgroundId = string;
export const NO_BACKGROUND = 'none';
export const CUSTOM_BACKGROUND = 'custom';

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
 * 主界面背景层：内置场景（DOM 动画）与自定义图共用同一套淡入交替。
 * 新内容就绪（图片解码完成）后才开始过渡，不闪空底；层按首个视口尺寸铺满，不随软键盘缩放。
 *
 * 自定义图适配：object-fit:cover 铺满任意机型不留边；对焦点按图片与屏幕宽高比自动取——
 * 图比屏幕瘦长（要裁上下）时取 30% 高度，保住多在上半部的人物/主体；否则居中裁左右。
 * 旋转屏幕后重新对焦。
 */
export class ChatBackgroundLayer {
  private readonly root = document.createElement('div');
  private slots: HTMLElement[] = [];
  private front = 0;
  private current = '';
  private objectUrl: string | null = null;
  private token = 0;
  private still = false;

  constructor() {
    this.root.className = 'chat-bg';
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
    document.body.prepend(this.root);
    // 钉住首个视口高度：键盘弹出 WebView 变矮时背景不被挤压拉伸。
    const pin = () => { this.root.style.height = `${window.innerHeight}px`; };
    let lastWidth = window.innerWidth;
    pin();
    window.addEventListener('resize', () => {
      // 只在宽度变化（旋转屏幕）时重钉；仅高度变小视为键盘弹出。
      if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; pin(); this.refocus(); }
      else if (window.innerHeight > parseFloat(this.root.style.height || '0')) pin();
    });
  }

  /** 省电模式/暂停渲染时冻结场景动画（只停 CSS 动画，不改画面）。 */
  setStill(still: boolean): void {
    this.still = still;
    for (const slot of this.slots) slot.querySelector('.bg-scene')?.classList.toggle('still', still);
  }

  async apply(id: ChatBackgroundId, dim: number): Promise<void> {
    this.root.style.setProperty('--bg-dim', String(Math.min(0.8, Math.max(0, dim))));
    const token = ++this.token;
    const scene = CHAT_SCENES.find(p => p.id === id);
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
      this.swapObjectUrl(null);
      this.clearHidden();
      return;
    }
    const next = this.slots[1 - this.front];
    next.replaceChildren();
    if (scene) {
      const el = scene.build();
      el.classList.toggle('still', this.still);
      next.append(el);
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
    next.classList.add('shown');
    this.slots[this.front].classList.remove('shown');
    this.front = 1 - this.front;
    this.swapObjectUrl(objectUrl);
    this.clearHidden();
  }

  /** 对焦点：竖图（比屏幕更瘦长）上移到 30%，其余居中。 */
  private focus(img: HTMLImageElement): void {
    const imgRatio = img.naturalWidth / Math.max(1, img.naturalHeight);
    const viewRatio = window.innerWidth / Math.max(1, parseFloat(this.root.style.height) || window.innerHeight);
    img.style.objectPosition = imgRatio < viewRatio ? '50% 30%' : '50% 50%';
  }

  private refocus(): void {
    const img = this.slots[this.front].querySelector<HTMLImageElement>('.chat-bg-img');
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
