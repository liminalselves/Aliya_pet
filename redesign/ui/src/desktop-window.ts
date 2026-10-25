/**
 * 桌面几何的唯一适配边界。
 * Windows 保留物理坐标；macOS 使用全局 Cocoa points（左上原点），scaleFactor=1。
 * PhysicalPosition/Size 在这里是“桌面单位”容器，不能与原始 Tauri 几何混用。
 * 渲染分辨率继续由 window.devicePixelRatio 决定，不受此几何比例影响。
 */
import * as native from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { desktopOS } from './platform';

export { LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
export type { Monitor } from '@tauri-apps/api/window';
export type Window = Pick<native.Window, 'label' | 'outerPosition' | 'innerPosition' | 'innerSize' | 'outerSize' |
  'scaleFactor' | 'setPosition' | 'setSize' | 'setAlwaysOnTop' | 'onMoved' | 'onScaleChanged'>;

interface Rect { x: number; y: number; width: number; height: number }
interface PointMonitor { name: string; bounds: Rect; workArea: Rect }
interface Geometry { outer: Rect; inner: Rect; backingScale: number; monitor: PointMonitor | null }
const geometry = () => invoke<Geometry>('desktop_geometry');
const position = (r: Rect) => new native.PhysicalPosition(r.x, r.y);
const size = (r: Rect) => new native.PhysicalSize(r.width, r.height);

function monitor(value: PointMonitor | null): native.Monitor | null {
  return value && { name: value.name, position: position(value.bounds), size: size(value.bounds),
    workArea: { position: position(value.workArea), size: size(value.workArea) }, scaleFactor: 1 };
}

export async function currentMonitor(): Promise<native.Monitor | null> {
  return desktopOS === 'macos' ? monitor((await geometry()).monitor) : native.currentMonitor();
}

export async function primaryMonitor(): Promise<native.Monitor | null> {
  return desktopOS === 'macos' ? monitor(await invoke<PointMonitor | null>('desktop_primary_monitor')) : native.primaryMonitor();
}

export function getCurrentWindow(): Window {
  const win = native.getCurrentWindow();
  const mac = desktopOS === 'macos';
  return {
    label: win.label,
    outerPosition: async () => mac ? position((await geometry()).outer) : win.outerPosition(),
    innerPosition: async () => mac ? position((await geometry()).inner) : win.innerPosition(),
    outerSize: async () => mac ? size((await geometry()).outer) : win.outerSize(),
    innerSize: async () => mac ? size((await geometry()).inner) : win.innerSize(),
    scaleFactor: async () => mac ? 1 : win.scaleFactor(),
    setPosition: value => {
      if (!mac) return win.setPosition(value);
      const point = 'position' in value ? value.position : value;
      return invoke('desktop_set_position', { x: point.x, y: point.y });
    },
    setSize: value => {
      if (!mac) return win.setSize(value);
      const dimensions = 'size' in value ? value.size : value;
      return win.setSize(new native.LogicalSize(dimensions.width, dimensions.height));
    },
    setAlwaysOnTop: enabled => win.label === 'pet'
      ? invoke('set_pet_always_on_top', { enabled }) : win.setAlwaysOnTop(enabled),
    // Moved events only invalidate the cache; coordinates are read atomically via geometry().
    onMoved: handler => win.onMoved(handler),
    onScaleChanged: handler => win.onScaleChanged(event => {
      if (!mac) return handler(event);
      const { width, height } = event.payload.size;
      handler({ ...event, payload: { scaleFactor: 1,
        size: new native.PhysicalSize(width / event.payload.scaleFactor, height / event.payload.scaleFactor) } });
    }),
  };
}
