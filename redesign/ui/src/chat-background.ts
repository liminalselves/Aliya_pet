/**
 * Android 主界面聊天背景：预设图 + 用户自定义图（存 IndexedDB，主界面与设置页同源共享）。
 * 选中项与遮罩强度存在设置里（PetSettings.chatBackground / chatBackgroundDim）。
 */

/** 预设背景清单：替换 assets/backgrounds/ 下的文件即可换图，增删条目即可增删选项。 */
export const PRESET_BACKGROUNDS: ReadonlyArray<{ id: string; name: string; url: string }> = [
  { id: 'dusk', name: '暮色', url: '/backgrounds/dusk.svg' },
  { id: 'study', name: '书房', url: '/backgrounds/study.svg' },
  { id: 'garden', name: '庭院', url: '/backgrounds/garden.svg' },
];

/** 'none' = 纯色底；'custom' = 用户上传的图；其余为预设 id。 */
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
 * 主界面背景层：两层 img 交替淡入，切换时新图解码完成才开始过渡，不闪空底。
 * 层固定按初始视口尺寸铺满（不随软键盘弹出缩放），遮罩强度由 --bg-dim 控制。
 */
export class ChatBackgroundLayer {
  private readonly root = document.createElement('div');
  private layers: HTMLImageElement[] = [];
  private front = 0;
  private current = '';
  private objectUrl: string | null = null;
  private token = 0;

  constructor() {
    this.root.className = 'chat-bg';
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      this.layers.push(img);
      this.root.append(img);
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
      if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; pin(); }
      else if (window.innerHeight > parseFloat(this.root.style.height || '0')) pin();
    });
  }

  async apply(id: ChatBackgroundId, dim: number): Promise<void> {
    this.root.style.setProperty('--bg-dim', String(Math.min(0.8, Math.max(0, dim))));
    const token = ++this.token;
    let url = '';
    let objectUrl: string | null = null;
    if (id === CUSTOM_BACKGROUND) {
      const blob = await loadCustomBackground();
      if (token !== this.token) return;
      if (blob) { objectUrl = URL.createObjectURL(blob); url = objectUrl; }
    } else {
      url = PRESET_BACKGROUNDS.find(p => p.id === id)?.url ?? '';
    }
    const key = id === CUSTOM_BACKGROUND ? `custom:${url ? 'set' : ''}` : url;
    if (key === this.current && id !== CUSTOM_BACKGROUND) { if (objectUrl) URL.revokeObjectURL(objectUrl); return; }
    if (!url) {
      this.current = '';
      for (const l of this.layers) l.classList.remove('shown');
      this.root.classList.remove('active');
      this.swapObjectUrl(null);
      return;
    }
    const next = this.layers[1 - this.front];
    next.src = url;
    try { await next.decode(); } catch { /* 解码失败也照常切换，避免卡在旧图 */ }
    if (token !== this.token) { if (objectUrl) URL.revokeObjectURL(objectUrl); return; }
    this.current = key;
    this.root.classList.add('active');
    next.classList.add('shown');
    this.layers[this.front].classList.remove('shown');
    this.front = 1 - this.front;
    this.swapObjectUrl(objectUrl);
  }

  /** 旧自定义图的 objectURL 等淡出结束再释放。 */
  private swapObjectUrl(next: string | null): void {
    const old = this.objectUrl;
    this.objectUrl = next;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 600);
  }
}
