/**
 * 更新服务配置（唯一权威来源）。
 *
 * 发布服务按列表顺序尝试：单个 base 网络错误 / 非 2xx / 超时（check.ts 的 6s）
 * 就落到下一个；全部失败才算检查失败。CORS 由服务端开放。
 *
 * 本地联调可用 `VITE_UPDATE_BASES=http://127.0.0.1:8787`（逗号分隔多个）
 * 覆盖内置列表，与 VITE_MSK_ORIGIN 同一套构建期注入（vite.config define 之外
 * 的 import.meta.env）。
 */

export const DEFAULT_UPDATE_BASES = ['https://aliyapet.liminalselves.top'];

function parseBases(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\//.test(s));
  return list.length ? list : [...DEFAULT_UPDATE_BASES];
}

/** 内置 + 构建期覆盖后的发布服务 base 列表（无尾斜杠）。 */
export const UPDATE_SERVICE_BASES: string[] = parseBases(
  import.meta.env.VITE_UPDATE_BASES
);

/** 「跳过此版本」持久化键（localStorage，双端 WebView 各自持有）。 */
export const UPDATE_SKIP_KEY = 'aliya_pet_update_skip';
