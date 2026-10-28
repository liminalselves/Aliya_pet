/**
 * 平台适配层：统一封装窗口/系统能力，上层（pet-app / settings-page）
 * 不再直接依赖 Tauri API。
 *
 * 三种环境：
 *  - tauri   Windows 桌面壳（WebView2 + @tauri-apps/api）
 *  - android Android 壳（Kotlin 注入 window.AndroidShell 桥）
 *  - web     纯浏览器（开发降级：无窗口操作）
 *
 * Android 桥（ShellBridge.kt，同步 JS Interface）：
 *   getMetrics()/moveWindowBy()/setWindowSize()/setWindowPos() 单位均为 CSS px，
 *   壳侧乘 density 换算物理像素；触摸拖动复用 pet-app 的手动增量位移逻辑。
 */

export type PlatformKind = 'tauri' | 'android' | 'web';

/** Kotlin ShellBridge 经 addJavascriptInterface 注入的对象。 */
export interface AndroidShell {
  getMetrics(): string;
  moveWindowBy(dxCss: number, dyCss: number): void;
  setWindowSize(wCss: number, hCss: number): void;
  setWindowPos(xCss: number, yCss: number): void;
  /** 原子设置窗口矩形（CSS px）：内容贴合模式下逐帧调用。 */
  setWindowRect(xCss: number, yCss: number, wCss: number, hCss: number): void;
  /** 窗口平滑平移（CSS px，原生动画）；完成回调 __pet.onNativeSnapEnd，被抓起打断回调 onNativeSnapInterrupted。 */
  animateWindowTo?(xCss: number, yCss: number, durationMs: number): void;
  /** 容器类型：activity=App 内全屏 / overlay=悬浮窗。 */
  getMode(): string;
  openUrl(url: string): void;
  /** 悬浮窗权限是否已授予（设置页状态行；ShellBridge.isOverlayGranted）。 */
  isOverlayGranted(): boolean;
  setAutoStart(on: boolean): void;
  isAutoStart(): boolean;
  /** 壳侧键值存储（SharedPreferences）：悬浮窗位置、退出转悬浮窗开关等。 */
  setPref(key: string, value: string): void;
  getPref(key: string): string;
  /** 打开主界面 / 打开设置 / 隐藏悬浮窗 / 退出。 */
  shellAction(action: string): void;
  /** 声明当前手势是抚摸/互动（悬浮窗壳据此不抢拖动）；手势结束传 false。 */
  setInteracting(interacting: boolean): void;
  /** 像素占用掩码（0/1 字符串， cols×rows 覆盖整个窗口）：壳命中透明区时穿透触摸。 */
  setHitMask(cols: number, rows: number, data: string): void;
  /** 独立台词气泡：JSON 含文本、窗口内锚点和适配视口；空文本隐藏，closing 淡出。 */
  setDialogueBubble?(json: string): void;
  /** 设置页全量设置变更（JSON）：壳转发给桌宠页实时生效。 */
  notifySettings(json: string): void;
  /** 设置页动作转发（play-action/express/set-mood 等 tray-action 形状 JSON）给桌宠页。 */
  notifyPetAction(json: string): void;
}

export interface WindowMetrics {
  /** 物理像素 / CSS 像素。 */
  density: number;
  /** 屏幕逻辑（CSS）尺寸。 */
  screenW: number;
  screenH: number;
  /** 窗口左上角（CSS px）。 */
  winX: number;
  winY: number;
  /** 窗口尺寸（CSS px）。 */
  winW: number;
  winH: number;
}

function detectPlatform(): PlatformKind {
  // ?platform=android 供桌面/浏览器联调模拟 Android 壳
  const forced = new URLSearchParams(location.search).get('platform');
  if (forced === 'android' || forced === 'tauri' || forced === 'web') {
    return forced;
  }
  if (typeof (window as unknown as { AndroidShell?: AndroidShell }).AndroidShell !== 'undefined') {
    return 'android';
  }
  if (typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined') {
    return 'tauri';
  }
  return 'web';
}

export const platform: PlatformKind = detectPlatform();

export function androidShell(): AndroidShell | null {
  return platform === 'android'
    ? (window as unknown as { AndroidShell?: AndroidShell }).AndroidShell ?? null
    : null;
}

/** 是否 Android 悬浮窗容器（内容贴合渲染/窗口模式的判定依据）。 */
export function isAndroidOverlay(): boolean {
  if (platform !== 'android') return false;
  try {
    return androidShell()?.getMode() === 'overlay';
  } catch {
    return false;
  }
}

/** 是否触摸设备（触摸端：单指按头部=抚摸，其余区域拖动）。 */
export const isTouchDevice: boolean =
  typeof window !== 'undefined' &&
  (('ontouchstart' in window && navigator.maxTouchPoints > 0) ||
    navigator.maxTouchPoints > 1);

// ---------- 窗口能力 ----------

export async function getWindowMetrics(): Promise<WindowMetrics | null> {
  if (platform === 'android') {
    const shell = androidShell();
    if (!shell) return null;
    try {
      return JSON.parse(shell.getMetrics()) as WindowMetrics;
    } catch {
      return null;
    }
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/window');
      const win = m.getCurrentWindow();
      const [mon, scale, outer, size] = await Promise.all([
        m.currentMonitor(),
        win.scaleFactor(),
        win.outerPosition(),
        win.outerSize(),
      ]);
      const density = scale;
      return {
        density,
        screenW: (mon?.size.width ?? 0) / density,
        screenH: (mon?.size.height ?? 0) / density,
        winX: outer.x / density,
        winY: outer.y / density,
        winW: size.width / density,
        winH: size.height / density,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** 按增量移动窗口（CSS px，右/下为正）。 */
export async function moveWindowBy(dx: number, dy: number): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.moveWindowBy(dx, dy);
    return true;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/window');
      const win = m.getCurrentWindow();
      const density = await win.scaleFactor();
      const pos = await win.outerPosition();
      await win.setPosition(
        new m.PhysicalPosition(
          Math.round(pos.x + dx * density),
          Math.round(pos.y + dy * density)
        )
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Android：原子设置窗口矩形（CSS px）。 */
export async function setWindowRect(
  x: number,
  y: number,
  w: number,
  h: number
): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.setWindowRect(x, y, w, h);
    return true;
  }
  return false;
}

export async function setWindowSize(w: number, h: number): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.setWindowSize(w, h);
    return true;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/window');
      await m.getCurrentWindow().setSize(new m.LogicalSize(w, h));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function setWindowPos(x: number, y: number): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.setWindowPos(x, y);
    return true;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/window');
      const win = m.getCurrentWindow();
      const density = await win.scaleFactor();
      await win.setPosition(
        new m.PhysicalPosition(Math.round(x * density), Math.round(y * density))
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function setAlwaysOnTop(on: boolean): Promise<void> {
  if (platform === 'tauri') {
    import('@tauri-apps/api/window')
      .then((m) => m.getCurrentWindow().setAlwaysOnTop(on))
      .catch(() => {});
  }
  // android：悬浮窗天然置顶；web：无操作
}

// ---------- 系统能力 ----------

export async function openUrl(url: string): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.openUrl(url);
    return true;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/core');
      await m.invoke('open_url', { url });
      return true;
    } catch {
      return false;
    }
  }
  window.open(url, '_blank');
  return true;
}

export async function setAutoStart(on: boolean): Promise<boolean> {
  if (platform === 'android') {
    androidShell()?.setAutoStart(on);
    return androidShell()?.isAutoStart() === on;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/core');
      await m.invoke('set_auto_start', { enabled: on });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function isAutoStart(): Promise<boolean> {
  if (platform === 'android') {
    return androidShell()?.isAutoStart() === true;
  }
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/core');
      return (await m.invoke<boolean>('get_auto_start')) === true;
    } catch {
      return false;
    }
  }
  return false;
}

// ---------- 壳侧键值（Android）/ 跨会话通知 ----------

export function setShellPref(key: string, value: string): void {
  if (platform === 'android') androidShell()?.setPref(key, value);
}

export function getShellPref(key: string): string {
  if (platform === 'android') return androidShell()?.getPref(key) ?? '';
  return '';
}

/** 请求壳执行动作：open-main / open-settings / hide-overlay / exit。 */
export function shellAction(action: string): void {
  if (platform === 'android') androidShell()?.shellAction(action);
}

/** 设置页 → 桌宠页动作转发（Android 双 WebView）：tray-action 形状。 */
export function notifyPetAction(payload: Record<string, unknown>): void {
  if (platform === 'android') {
    try {
      androidShell()?.notifyPetAction?.(JSON.stringify(payload));
    } catch {
      // 旧桥无此方法时静默
    }
  }
}
