/**
 * 版本检查纯逻辑 + 发布服务客户端。
 *
 * 端点：GET {base}/api/check?platform=windows|android&version=0.1.0
 *  - 有更新：{ updateAvailable:true, mandatory, current, latest, publishedAt,
 *             notes, downloadUrl, size, releasePage }
 *  - 无更新：{ updateAvailable:false, mandatory:false, current, latest }
 * base 列表见 config.ts（按序回退，单 base 6s 超时）。
 */

import { UPDATE_SERVICE_BASES, UPDATE_SKIP_KEY } from './config';

export type UpdatePlatform = 'windows' | 'android';

/** /api/check 响应（无更新时仅前四个字段有值）。 */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  mandatory: boolean;
  current: string;
  latest: string;
  publishedAt?: string;
  /** markdown 更新说明（弹窗内安全渲染，见 markdown.ts）。 */
  notes?: string;
  /** Android APK 下载直链。 */
  downloadUrl?: string;
  /** 安装包字节数（可选展示）。 */
  size?: number;
  /** 发布页（手动下载回退入口）。 */
  releasePage?: string;
}

/** 比较两个点分数字版本（前导 v 可选，缺段补 0，非数字段按 0 处理）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const va = parse(a);
  const vb = parse(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------- 「跳过此版本」/「稍后」 ----------

let deferredThisLaunch = false;

function readSkip(): string {
  try {
    return localStorage.getItem(UPDATE_SKIP_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 记住跳过的版本（localStorage 持久，直到出现更新的版本）。 */
export function skipVersion(version: string): void {
  try {
    localStorage.setItem(UPDATE_SKIP_KEY, version);
  } catch {
    // 存储不可用则本次会话内仍可通过内存标记生效
  }
}

/** 「稍后」：仅本次启动内不再提醒。 */
export function deferUpdateForLaunch(): void {
  deferredThisLaunch = true;
}

/**
 * 启动检查决策：是否弹出更新提示。
 * 服务端异常数据（latest 不比 current 新）不提示；强制更新无视跳过/稍后；
 * 其余情况尊重用户的跳过与本次启动的「稍后」。手动「检查更新」入口不调用
 * 本函数（用户主动询问，直接展示结果）。
 */
export function shouldPromptUpdate(result: UpdateCheckResult): boolean {
  if (!result.updateAvailable) return false;
  if (!isNewer(result.latest, result.current)) return false;
  if (result.mandatory) return true;
  if (deferredThisLaunch) return false;
  return readSkip() !== result.latest;
}

// ---------- 发布服务客户端 ----------

export class UpdateCheckError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CheckOptions {
  fetchImpl?: FetchLike;
  /** 单个 base 的超时（ms），默认 6000。 */
  timeoutMs?: number;
}

function coerceResult(data: unknown): UpdateCheckResult {
  if (!data || typeof data !== 'object') throw new UpdateCheckError('响应不是对象');
  const r = data as Record<string, unknown>;
  if (typeof r.latest !== 'string' || typeof r.current !== 'string') {
    throw new UpdateCheckError('响应缺少 current/latest');
  }
  return {
    updateAvailable: r.updateAvailable === true,
    mandatory: r.mandatory === true,
    current: r.current,
    latest: r.latest,
    publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : undefined,
    notes: typeof r.notes === 'string' ? r.notes : undefined,
    downloadUrl: typeof r.downloadUrl === 'string' ? r.downloadUrl : undefined,
    size: typeof r.size === 'number' ? r.size : undefined,
    releasePage: typeof r.releasePage === 'string' ? r.releasePage : undefined,
  };
}

async function checkOnce(
  base: string,
  platform: UpdatePlatform,
  version: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(
      `${base}/api/check?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(version)}`,
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new UpdateCheckError(`HTTP ${res.status}`);
  return coerceResult(await res.json());
}

/** 依次尝试 base 列表；网络错误 / 非 2xx / 超时落到下一个，全部失败抛 UpdateCheckError。 */
export async function checkForUpdate(
  platform: UpdatePlatform,
  version: string,
  options: CheckOptions = {}
): Promise<UpdateCheckResult> {
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 6000;
  let lastError: unknown = null;
  for (const base of UPDATE_SERVICE_BASES) {
    try {
      return await checkOnce(base, platform, version, fetchImpl, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw new UpdateCheckError(`更新检查失败：${String(lastError)}`);
}
