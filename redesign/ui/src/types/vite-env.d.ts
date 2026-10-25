/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MSK_ORIGIN?: string;
}

// vite.config.ts define 注入的应用版本号（来源 ui/package.json）
declare const __APP_VERSION__: string;
declare const __DESKTOP_OS__: string;
