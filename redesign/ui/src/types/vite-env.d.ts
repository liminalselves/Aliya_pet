/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MSK_ORIGIN?: string;
  /** 覆盖发布服务 base 列表（逗号分隔），见 src/update/config.ts。 */
  readonly VITE_UPDATE_BASES?: string;
}

// vite.config.ts define 注入的应用版本号（来源 ui/package.json）
declare const __APP_VERSION__: string;
