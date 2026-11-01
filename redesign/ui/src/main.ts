import { PetApp } from './pet-app';
import { showStartupNotice } from './startup-notice';
import { scheduleStartupUpdateCheck } from './update/startup';
import { shellAction } from './platform';
import './pet.css';

/**
 * 入口：Cubism Core（Emscripten）异步初始化完成后启动应用。
 * 就绪判据用 csmGetMocVersion 双参调用——比 csmGetVersion 更能反映
 * wasm 堆（HEAPU8）已可用。
 */
function coreReady(): boolean {
  try {
    Live2DCubismCore.Version.csmGetLatestMocVersion();
    const b = new ArrayBuffer(64);
    Live2DCubismCore.Version.csmGetMocVersion(
      new Uint8Array(b),
      b.byteLength
    );
    return true;
  } catch (e) {
    return false;
  }
}

function startWhenCoreReady(): void {
  if (!coreReady()) {
    setTimeout(startWhenCoreReady, 50);
    return;
  }
  console.log(
    '[pet] cubism core ready, version =',
    Live2DCubismCore.Version.csmGetVersion()
  );
  void (async () => {
    const app = new PetApp();
    if (!app.initialize()) throw new Error('WebGL2 初始化失败');
    // 在异步加载之前暴露桥接入口，让启动期间的操作也能排队。
    (window as unknown as Record<string, unknown>).__pet = app;
    (window as unknown as Record<string, unknown>).__applySettingsFromAndroid = (s: unknown) => {
      if (s && typeof s === 'object') app.applySettings(s as never, false);
    };
    await app.loadModel('/live2d/aliya/16.model3.json');
    // 模型就绪后延迟静默检查更新（失败不打扰；展示分叉见 update/startup.ts）
    scheduleStartupUpdateCheck();
  })().catch(error => {
    console.error('[pet] startup failed', error);
    // 撤掉安卓启动遮罩、放出聊天界面，让网页内的故障提示可见。
    document.body.classList.add('pet-ready');
    shellAction('pet-ready');
    showStartupNotice('pet-startup-error', '桌宠启动失败，请重新加载重试。', error,
      async () => { window.location.reload(); });
  });
}

startWhenCoreReady();
