import { PetApp } from './pet-app';

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
  const app = new PetApp();
  app.initialize();
  app.loadModel('/live2d/aliya/16.model3.json');
  // 调试句柄（CDP 验证用）
  (window as unknown as Record<string, unknown>).__pet = app;
  // 安卓设置页（第二 WebView）经壳桥转发的实时设置
  (window as unknown as Record<string, unknown>).__applySettingsFromAndroid = (
    s: unknown
  ) => {
    if (s && typeof s === 'object') app.applySettings(s as never, false);
  };
}

startWhenCoreReady();
