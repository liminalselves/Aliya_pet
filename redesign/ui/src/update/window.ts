/**
 * Windows 更新窗口页面（update.html，预创建隐藏，由 show_update 命令唤起）。
 *
 * 数据来源：pet / 设置页检查 /api/check 后把结果经 Rust `show_update` 转交
 * （`update-open` 事件）；页面加载早于任何检查，但为兜底 HMR 整页重载等时序，
 * 启动时再主动取一次 `current_update_payload`。
 *
 * 「立即更新」走官方 updater 插件（tauri.conf.json plugins.updater 端点）：
 * 下载 → 校验签名 → NSIS passive 安装；Windows 上安装器启动后应用自动退出。
 */

import type { UpdateCheckResult } from './check';
import { UpdateDialog } from './dialog';
import { platform } from '../platform';

function isCheckResult(data: unknown): data is UpdateCheckResult {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as UpdateCheckResult).latest === 'string' &&
    typeof (data as UpdateCheckResult).current === 'string'
  );
}

/** updater 插件安装流程：进度上屏，失败给重试 + 手动下载回退。 */
async function installWithUpdater(dialog: UpdateDialog): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) throw new Error('服务端未提供当前平台的更新包');
  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        dialog.setProgress(0, total);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        dialog.setProgress(downloaded, total);
        break;
      case 'Finished':
        dialog.setInstalling();
        break;
    }
  });
  // 正常流程到不了这里：安装器启动前应用已被插件要求退出。
  dialog.setInstalling();
}

async function hideWindow(): Promise<void> {
  try {
    const m = await import('@tauri-apps/api/window');
    await m.getCurrentWindow().hide();
  } catch {
    // 隐藏失败不影响状态（窗口残留可手动关，Rust 侧按非强制处理为隐藏）
  }
}

function render(data: unknown): void {
  if (!isCheckResult(data)) return;
  const app = document.getElementById('app')!;
  app.replaceChildren();
  const dialog = new UpdateDialog(data, 'window', {
    primary: (d) => {
      d.setProgress(0, 0);
      installWithUpdater(d).catch((error) => {
        d.showError(error instanceof Error ? error.message : String(error));
      });
    },
    onClose: () => {
      void hideWindow();
    },
  });
  app.appendChild(dialog.root);
}

if (platform === 'tauri') {
  void (async () => {
    const ev = await import('@tauri-apps/api/event');
    await ev.listen<UpdateCheckResult>('update-open', (e) => render(e.payload));
    // 兜底：监听装好之前就可能触发的显示（整页重载后）
    const { invoke } = await import('@tauri-apps/api/core');
    const pending = await invoke<UpdateCheckResult | null>('current_update_payload');
    if (pending) render(pending);
  })().catch((error) => {
    console.error('[update] window init failed', error);
  });
} else {
  // 浏览器预览 update.html：给个静态占位，避免白屏难辨
  document.getElementById('app')!.textContent =
    '更新窗口仅在 Windows 桌面壳内使用。';
}
