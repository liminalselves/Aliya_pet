/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppDelegate } from './lappdelegate';
import * as LAppDefine from './lappdefine';

type HostMessage = {
  type?: string;
  x?: number;
  y?: number;
  value?: boolean;
};

type WebViewHost = {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HostMessage>) => void
  ): void;
};

const host = (
  window as Window & { chrome?: { webview?: WebViewHost } }
).chrome?.webview;

/**
 * ブラウザロード後の処理
 */
window.addEventListener(
  'load',
  (): void => {
    // Initialize WebGL and create the application instance
    const app = LAppDelegate.getInstance();
    if (!app.initialize()) {
      host?.postMessage({ type: 'error', message: 'WebGL 初始化失败' });
      return;
    }

    host?.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'look':
          app.setLookTarget(message.x ?? 0, message.y ?? 0);
          break;
        case 'speaking':
          app.setSpeaking(message.value === true);
          break;
        case 'click':
          app.triggerClick();
          break;
      }
    });

    app.run();

    const readyTimer = window.setInterval(() => {
      if (app.isReady()) {
        window.clearInterval(readyTimer);
        host?.postMessage({ type: 'ready' });
      }
    }, 100);

    window.setTimeout(() => {
      if (!app.isReady()) {
        window.clearInterval(readyTimer);
        host?.postMessage({ type: 'error', message: 'Live2D 模型加载超时' });
      }
    }, 10000);
  },
  { passive: true }
);

/**
 * 終了時の処理
 */
window.addEventListener(
  'beforeunload',
  (): void => LAppDelegate.releaseInstance(),
  { passive: true }
);
