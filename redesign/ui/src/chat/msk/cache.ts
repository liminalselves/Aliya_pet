/**
 * 低频变化的只读接口缓存（角色正则、全站表情）：localStorage 同源共享，
 * 聊天主界面与记录页（Android 独立 WebView / Windows 独立窗口）共用一份。
 *
 * 策略：新鲜期内直接用缓存；过期但有旧值时先用旧值、后台刷新（stale-while-revalidate）；
 * 无缓存才等待网络。同一键的并发请求合并为一次。
 */
import { mskStorageKey } from './config';
import { fetchCustomEmojis } from '../rendering/emoji';
import type { CustomEmojiInfo, MskApiCaller } from '../rendering/types';

interface Entry<T> { at: number; value: T }

const inflight = new Map<string, Promise<unknown>>();

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function read<T>(key: string): Entry<T> | null {
  try {
    const raw = storage()?.getItem(key);
    const entry = raw ? JSON.parse(raw) as Entry<T> : null;
    return entry && typeof entry.at === 'number' ? entry : null;
  } catch { return null; }
}

function write<T>(key: string, value: T): void {
  try { storage()?.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch { /* 配额满时只用内存结果 */ }
}

function refresh<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const task = fetcher()
    .then(value => { write(key, value); return value; })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 按 name 取缓存值；fetcher 不接收调用方信号，后台刷新不会因页面切换被中断。 */
export async function cachedFetch<T>(name: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const key = mskStorageKey(`aliya_cache:${name}`);
  const entry = read<T>(key);
  if (entry && Date.now() - entry.at < ttlMs) return entry.value;
  if (entry) {
    void refresh(key, fetcher).catch(() => {});
    return entry.value;
  }
  return refresh(key, fetcher);
}

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 角色正则（agents/characters/show 的 regexRules 原样），失败时空表，不阻断打开会话。 */
export function cachedCharacterRules(api: MskApiCaller, characterId: string): Promise<unknown> {
  return cachedFetch(`character-rules:${characterId}`, CACHE_TTL_MS,
    () => api<{ regexRules?: unknown }>('agents/characters/show', { characterId }).then(d => d?.regexRules ?? []))
    .catch((): unknown[] => []);
}

/** 全站表情表（POST /api/emojis 规范化后）。 */
export function cachedCustomEmojis(api: MskApiCaller): Promise<CustomEmojiInfo[]> {
  return cachedFetch('emojis', CACHE_TTL_MS, () => fetchCustomEmojis(api));
}
