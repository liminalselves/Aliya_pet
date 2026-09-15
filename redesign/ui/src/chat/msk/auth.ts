import { MskClient, type FetchLike, type MskUser } from './client';
import { MSK_BASE, MSK_TOKEN_KEY as TOKEN_KEY, MSK_USER_KEY as USER_KEY, MSK_PENDING_KEY as PENDING_KEY } from './config';
import { platform, openUrl, androidShell } from '../../platform';
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface AuthResult { token: string; user: MskUser }

export class MskAuth {
  private memoryToken = '';
  constructor(private readonly storage?: StorageLike, private readonly fetchImpl?: FetchLike) {
    try { this.memoryToken = storage?.getItem(TOKEN_KEY) ?? ''; } catch { /* Memory-only session. */ }
  }
  get token(): string { return this.memoryToken; }
  savedUser(): MskUser | null {
    try { return JSON.parse(this.storage?.getItem(USER_KEY) ?? 'null'); } catch { return null; }
  }
  async validateSaved(signal?: AbortSignal): Promise<MskUser | null> {
    if (!this.token) return null;
    const user = await new MskClient(this.token, this.fetchImpl).validate(signal);
    this.save(this.token, user);
    return user;
  }
  private save(token: string, user: MskUser): void {
    this.memoryToken = token;
    try {
      this.storage?.setItem(TOKEN_KEY, token);
      this.storage?.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* Keep credentials in memory when storage is unavailable. */ }
  }
  logout(): void {
    this.memoryToken = '';
    try { this.storage?.removeItem(TOKEN_KEY); this.storage?.removeItem(USER_KEY); } catch { /* Optional storage. */ }
  }
  async loginManual(token: string, signal?: AbortSignal): Promise<AuthResult> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('请输入 token。');
    const user = await new MskClient(trimmed, this.fetchImpl).validate(signal);
    this.save(trimmed, user);
    return { token: trimmed, user };
  }
  private async exchange(session: string, signal?: AbortSignal): Promise<AuthResult> {
    signal?.throwIfAborted();
    const res = await (this.fetchImpl ?? fetch)(`${MSK_BASE}/api/miauth/${session}/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
    });
    const data = await res.json() as { ok?: boolean; token?: string; user?: MskUser };
    signal?.throwIfAborted();
    if (!res.ok || !data.ok || !data.token || !data.user?.id) throw new Error('未取得授权，请重新在浏览器中允许连接。');
    this.save(data.token, data.user);
    try { this.storage?.removeItem(PENDING_KEY); } catch { /* Optional storage. */ }
    return { token: data.token, user: data.user };
  }
  async resumeCallback(signal?: AbortSignal): Promise<AuthResult | null> {
    let pending: { session: string; at: number } | null = null;
    try { pending = JSON.parse(this.storage?.getItem(PENDING_KEY) ?? 'null'); } catch { return null; }
    if (!pending || Date.now() - pending.at > 300_000) return null;
    const query = platform === 'android' ? androidShell()?.getPref('miauth_callback') : location.search;
    if (new URLSearchParams(query ?? '').get('session') !== pending.session) return null;
    const result = await this.exchange(pending.session, signal);
    if (platform === 'android') androidShell()?.setPref('miauth_callback', '');
    else if (platform === 'web') history.replaceState(null, '', location.pathname);
    return result;
  }
  async loginBrowser(signal?: AbortSignal): Promise<AuthResult> {
    const session = crypto.randomUUID();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('授权等待已超时，请重新连接。')), 300_000);
    const abort = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
    let unlisten: (() => void) | undefined;
    let end: (() => Promise<unknown>) | undefined;
    let onResume: (() => void) | undefined;
    let callback = `${location.origin}${location.pathname}`;
    try {
      this.storage?.setItem(PENDING_KEY, JSON.stringify({ session, at: Date.now() }));
      let resolveCallback!: () => void;
      let rejectCallback!: (error: unknown) => void;
      const received = new Promise<void>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
      const check = (query: string) => {
        if (new URLSearchParams(query).get('session') === session) resolveCallback();
      };
      const onAbort = () => rejectCallback(abort.reason);
      abort.addEventListener('abort', onAbort, { once: true });
      // Register every receiver before launching the browser.
      if (platform === 'tauri') {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        // 壳侧回调事件仅发往本窗口：{ ok:true, query, session } 或 { ok:false, error, session }
        unlisten = await listen<{ ok: boolean; query?: string; error?: string; session: string }>('miauth-callback', e => {
          const p = e.payload;
          if (p.session !== session) return;
          if (!p.ok || !p.query) { rejectCallback(new Error(p.error === 'timeout' ? '授权等待已超时，请重新连接。' : '授权回调失败，请重试。')); return; }
          check(p.query);
        });
        const port = await invoke<number>('miauth_begin', { session });
        end = () => invoke('miauth_end', { session });
        callback = `http://127.0.0.1:${port}/miauth/callback`;
      } else if (platform === 'android') {
        callback = 'aliyapet://miauth/';
        onResume = () => check(androidShell()?.getPref('miauth_callback') ?? '');
        window.addEventListener('focus', onResume);
        document.addEventListener('visibilitychange', onResume);
        const poll = setInterval(onResume, 500);
        unlisten = () => clearInterval(poll);
      } else {
        received.catch(() => {}); // 整页跳转后本页面即卸载，received 无人等待，抑制悬空拒绝
        window.location.assign(this.authUrl(session, callback));
        return await new Promise<AuthResult>((_, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }));
      }
      abort.throwIfAborted();
      if (!await openUrl(this.authUrl(session, callback))) throw new Error('无法打开默认浏览器。');
      await received;
      abort.removeEventListener('abort', onAbort);
      const result = await this.exchange(session, abort);
      if (platform === 'android') androidShell()?.setPref('miauth_callback', '');
      return result;
    } finally {
      clearTimeout(timer);
      unlisten?.();
      if (onResume) { window.removeEventListener('focus', onResume); document.removeEventListener('visibilitychange', onResume); }
      await end?.();
    }
  }
  private authUrl(session: string, callback: string): string {
    const url = new URL(`${MSK_BASE}/miauth/${session}`);
    url.search = new URLSearchParams({ name: 'Aliya Pet', callback,
      permission: 'read:account,read:chat,write:chat,read:drive,write:drive' }).toString();
    return url.toString();
  }
}
