/**
 * 启动更新检查接线（pet 页）。
 *
 * 时机：模型加载完成后延迟 3s（不阻塞启动，避开首帧与设置恢复的网络争用）；
 * 网络失败静默。悬浮窗容器（Android overlay）不打扰——回主界面后由下次
 * 启动检查或设置页「检查更新」触发。
 *
 * 展示分叉：
 *  - Windows：pet 窗口透明且点击穿透，不能画弹窗 → Rust `show_update`
 *    唤起独立 update 窗口并转交检查结果（main.rs）。
 *  - Android：主界面 WebView 全屏可交互（命中掩码只在悬浮窗形态生效），
 *    直接挂页内 <dialog> 模态。
 */

import { checkForUpdate, shouldPromptUpdate } from './check';
import { openUpdateModal } from './dialog';
import { isAndroidOverlay, platform } from '../platform';

export const STARTUP_CHECK_DELAY_MS = 3000;

export async function runStartupUpdateCheck(): Promise<void> {
  if (platform === 'web') return;
  if (platform === 'android' && isAndroidOverlay()) return;
  let result;
  try {
    result = await checkForUpdate(
      platform === 'tauri' ? 'windows' : 'android',
      __APP_VERSION__
    );
  } catch {
    return; // 启动检查失败不打扰
  }
  if (!shouldPromptUpdate(result)) return;
  if (platform === 'tauri') {
    try {
      const m = await import('@tauri-apps/api/core');
      await m.invoke('show_update', { payload: result });
    } catch (error) {
      console.error('[update] show_update failed', error);
    }
    return;
  }
  openUpdateModal(result);
}

/** 模型就绪后调用：延迟静默检查一次。 */
export function scheduleStartupUpdateCheck(
  delayMs = STARTUP_CHECK_DELAY_MS
): void {
  window.setTimeout(() => {
    void runStartupUpdateCheck();
  }, delayMs);
}
