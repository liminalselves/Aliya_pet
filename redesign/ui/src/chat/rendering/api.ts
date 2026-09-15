/**
 * MskApiCaller 适配器：把渲染器的端点调用转成 MSK JSON POST。
 * 与 ../msk/client 的 MskClient 行为一致（token 放 i 字段、超时、中文错误、
 * 401/403/CREDENTIAL_REQUIRED 视为连接失效），并给错误附加服务端 errorCode，
 * 供生图状态机识别 AGENT_IMAGE_DISABLED 等情形。
 */
import type { FetchLike } from '../msk/client';
import { MSK_BASE } from '../msk/config';
import type { MskApiCaller } from './types';

export interface MskApiCallerOptions {
  token: string;
  /** 缺省用全局 fetch（Tauri/浏览器环境）。 */
  fetchImpl?: FetchLike;
  /** 单次请求超时，毫秒；默认 30s。 */
  timeoutMs?: number;
}

export class MskApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'MskApiError';
  }
}

export function createMskApiCaller(options: MskApiCallerOptions): MskApiCaller {
  const fetchImpl = options.fetchImpl ?? ((globalThis.fetch as unknown as FetchLike).bind(globalThis));
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async function call<T>(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${MSK_BASE}/api/${endpoint.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ i: options.token, ...body }),
        signal: controller.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new MskApiError(e instanceof Error && e.name === 'TimeoutError' ? '请求超时，请检查网络。' : '网络异常，请稍后重试。', 'NETWORK_ERROR', 0);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应当空对象处理 */ }
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    if (!res.ok || err) {
      if (res.status === 401 || res.status === 403 || err?.code === 'CREDENTIAL_REQUIRED') {
        throw new MskApiError('连接已失效，请重新授权。', 'CREDENTIAL_REQUIRED', res.status);
      }
      throw new MskApiError(err?.message ? `服务器拒绝了请求：${err.message}` : `请求失败（${res.status}）。`, err?.code ?? 'REQUEST_FAILED', res.status);
    }
    return data as T;
  };
}
