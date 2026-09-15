/**
 * MSK（Misskey Agent API）客户端。
 * 只实现桌宠聊天需要的最小集合：验权、会话、发消息、时间线。
 * 接口约定见 Aliya_web/MSK_API_USAGE.md；Token 放在 JSON 的 i 字段。
 */

import { DEFAULT_MSK_ORIGIN, MSK_BASE } from './config';

/** 桌宠固定对接的 Aliya 角色与文风（与 Aliya_web 一致）。 */
export const ALIYA_CHARACTER_ID = 'akqruskge8w6003j';
export const ALIYA_DIALOGUE_STYLE_ID = 'aofoi210vawt01t4';

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface MskUser {
  id: string;
  username: string;
  name?: string;
}

export interface MskSession {
  id: string;
  name?: string;
  characterId: string;
  characterName?: string;
  characterAvatar?: { thumbnailUrl?: string; url?: string } | null;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  hasUnread?: boolean;
}

export interface MskTimelineMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  file?: import('../rendering/types').DriveFileLike | null;
  createdAt: string;
}

/** 网络/接口错误统一成带中文信息的 Error。 */
function fail(message: string): never {
  throw new Error(message);
}

/** 已知上游错误码 → 用户可读的中文说明（服务器原文是英文，直接展示看不懂）。 */
const KNOWN_ERRORS: Record<string, string> = {
  AGENT_INSUFFICIENT_CREDIT: 'Agent 余额不足，充值后才能继续聊。',
  AGENT_VISION_INSUFFICIENT_CREDIT: '看图功能的余额不足。',
  AGENT_REPLY_PENDING: '上一条回复还在生成，稍等片刻再发。',
  AGENT_CLIENT_REQUEST_ID_REUSED: '请求标识冲突，请重试。',
  NO_SUCH_SESSION: '会话不存在或已不属于当前账号，请重新选择会话。',
  AGENT_MESSAGE_EMPTY: '消息不能为空。',
  AGENTS_LLM_FAILED: 'Aliya 暂时没能生成回复，请稍后重试。',
  AGENTS_MODEL_NOT_CONFIGURED: '当前没有可用的对话模型。',
};

/** 可中断的等待；中止时抛 AbortError 名的 Error（沙箱测试环境没有 DOMException）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (timer) clearTimeout(timer);
      const e = new Error('已取消'); e.name = 'AbortError'; reject(e);
    };
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class MskClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike).bind(globalThis),
  ) {}

  async post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const { status, data } = await this.postRaw(path, body, signal, timeoutMs);
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    if (status < 200 || status >= 300 || err) {
      if (status === 401 || status === 403 || err?.code === 'CREDENTIAL_REQUIRED') {
        fail('连接已失效，请重新授权。');
      }
      fail((err?.code && KNOWN_ERRORS[err.code]) ?? (err?.message ? `服务器拒绝了请求：${err.message}` : `请求失败（${status}）。`));
    }
    return data as T;
  }

  /** 只发请求并解析 JSON；非 2xx 不抛错（由调用方按状态决定），网络/超时/中止才抛。 */
  private async postRaw(path: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ status: number; data: unknown }> {
    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${MSK_BASE}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ i: this.token, ...body }),
        signal: combined,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      fail(e instanceof Error && e.name === 'TimeoutError' ? '请求超时，请检查网络。' : '网络异常，请稍后重试。');
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应当空对象处理 */ }
    return { status: res.status, data };
  }

  /** POST /api/i：验证 token 并取当前用户。 */
  async validate(signal?: AbortSignal): Promise<MskUser> {
    const data = await this.post<Record<string, unknown>>('/i', {}, signal, 15_000);
    if (!data || typeof data.id !== 'string') fail('授权无效，请重新连接。');
    return { id: data.id, username: String(data.username ?? ''), name: data.name as string | undefined };
  }

  /** POST /api/agents/sessions/list-mine。非官方实例不会持有官方 Aliya 角色，因此显示全部会话。 */
  async listAliyaSessions(signal?: AbortSignal): Promise<MskSession[]> {
    const list = await this.post<MskSession[]>('/agents/sessions/list-mine', {}, signal);
    const onlyOfficialAliya = MSK_BASE === DEFAULT_MSK_ORIGIN;
    return (Array.isArray(list) ? list : [])
      .filter(s => s && (!onlyOfficialAliya || s.characterId === ALIYA_CHARACTER_ID))
      .map(s => ({
        id: s.id,
        name: s.name,
        characterId: s.characterId,
        characterName: s.characterName,
        characterAvatar: s.characterAvatar ?? null,
        lastMessageAt: s.lastMessageAt,
        lastMessagePreview: s.lastMessagePreview,
        hasUnread: s.hasUnread,
      }));
  }

  /** 创建 Aliya 会话：先确保固定文风可用（不可用则订阅后再验）。 */
  async createSession(signal?: AbortSignal): Promise<MskSession> {
    const styles = await this.post<Array<{ id?: string }>>('/agents/styles/list-usable', {}, signal);
    if (!Array.isArray(styles) || !styles.some(s => s?.id === ALIYA_DIALOGUE_STYLE_ID)) {
      await this.post('/agents/styles/subscribe', { styleId: ALIYA_DIALOGUE_STYLE_ID }, signal);
      const again = await this.post<Array<{ id?: string }>>('/agents/styles/list-usable', {}, signal);
      if (!Array.isArray(again) || !again.some(s => s?.id === ALIYA_DIALOGUE_STYLE_ID)) {
        fail('当前账号无法使用 Aliya 的文风，创建会话失败。');
      }
    }
    const data = await this.post<Record<string, unknown>>('/agents/sessions/create', {
      characterId: ALIYA_CHARACTER_ID,
      dialogueStyleId: ALIYA_DIALOGUE_STYLE_ID,
      sessionKind: 'community',
    }, signal);
    const id = data?.id;
    if (typeof id !== 'string') fail('创建会话失败。');
    return { id, characterId: ALIYA_CHARACTER_ID, name: data.name as string | undefined };
  }

  /** POST /api/agents/messages/send：同步等待回复（上游最长 120s）。
   *  回执缺失时（空 200/204、网关 5xx、网络超时）按 Aliya_web 的成熟做法处理：
   *  消息多半已送达应用层，回复经时间线落库——轮询取回，而不是直接判失败。 */
  async send(sessionId: string, text: string, signal?: AbortSignal, requestId: string = crypto.randomUUID(), pollIntervalMs = 2500): Promise<{ text: string; messageId: string }> {
    const startedAt = Date.now();
    let status = 0;
    let data: Record<string, unknown> | null = null;
    // LLM 上游偶发失败时服务端会删除本轮用户消息并释放锁；复用 requestId 最多重试两次，既不重复入库也不让用户手点。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.postRaw('/agents/messages/send', { sessionId, text, clientRequestId: requestId }, signal, 120_000);
        status = res.status;
        data = res.data as Record<string, unknown> | null;
      } catch (e) {
        if (signal?.aborted) throw e;
        // 网络异常/超时：请求可能已到达应用层，不能盲重发；轮询确认送达并等回复。
        return this.awaitAssistantReply(sessionId, text, startedAt, signal, pollIntervalMs);
      }
      const code = (data as { error?: { code?: string } } | null)?.error?.code;
      if (code !== 'AGENTS_LLM_FAILED' || attempt === 2) break;
      await sleep(800 * (attempt + 1), signal);
    }
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    if (status === 401 || status === 403 || err?.code === 'CREDENTIAL_REQUIRED') fail('连接已失效，请重新授权。');
    if (err) fail((err.code && KNOWN_ERRORS[err.code]) ?? '服务器暂时无法完成请求，请稍后重试。');
    if (status < 200 || status >= 300) fail(status >= 500 ? '服务器暂时不可用，请稍后重试。' : `请求失败（${status}）。`);
    if (data?.auditCategory || data?.auditReason) fail('这条消息被审核拦截，没有产生回复。');
    const assistantText = typeof data?.assistantText === 'string' ? data.assistantText : '';
    const assistantMessageId = typeof data?.assistantMessageId === 'string' ? data.assistantMessageId : '';
    if (assistantText.trim() && assistantMessageId) return { text: assistantText, messageId: assistantMessageId };
    // 空回执（回复可能是内部控制消息、被整体过滤，或回执丢失）：轮询时间线等可见回复。
    return this.awaitAssistantReply(sessionId, text, startedAt, signal, pollIntervalMs);
  }

  /** 回执缺失的兜底：轮询时间线，先确认本次用户消息已落库，再等其后的助手回复。 */
  private async awaitAssistantReply(sessionId: string, text: string, startedAt: number, signal: AbortSignal | undefined, pollIntervalMs: number): Promise<{ text: string; messageId: string }> {
    const deadline = Date.now() + 90_000;
    let delivered = false;
    for (;;) {
      if (signal?.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }
      if (Date.now() >= deadline) break;
      await sleep(pollIntervalMs, signal);
      let list: MskTimelineMessage[];
      try {
        list = await this.timeline(sessionId, 20, signal);
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.message.includes('连接已失效'))) throw e;
        continue; // 轮询途中的瞬时失败不致命
      }
      // 从后往前找本次用户消息（同文本可能有多条，取最近一条）
      let userIdx = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.role === 'user' && m.content === text && Date.parse(m.createdAt) >= startedAt - 15_000) { userIdx = i; break; }
      }
      if (userIdx < 0) continue;
      delivered = true;
      const reply = list.slice(userIdx + 1).find(m => m.role === 'assistant' && m.content.trim());
      if (reply) return { text: reply.content, messageId: reply.id };
    }
    fail(delivered ? '回复没有按时到达，请稍后在「记录」里刷新确认。' : '发送可能未送达，请在「记录」里刷新确认后重试。');
  }

  async messagesAround(sessionId: string, messageId: string, signal?: AbortSignal): Promise<MskTimelineMessage[]> {
    const after = await this.post<MskTimelineMessage[]>('/agents/messages/timeline', { sessionId, sinceId: messageId, limit: 20 }, signal);
    after.sort((a, b) => a.id.localeCompare(b.id));
    const before = await this.post<MskTimelineMessage[]>('/agents/messages/timeline', {
      sessionId, limit: 21, ...(after.length ? { untilId: after[0].id } : {}),
    }, signal);
    return [...before, ...after].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** POST /api/agents/messages/timeline：按时间正序返回（过滤 system/内部消息）。 */
  async timeline(sessionId: string, limit = 30, signal?: AbortSignal): Promise<MskTimelineMessage[]> {
    const list = await this.post<MskTimelineMessage[]>('/agents/messages/timeline', { sessionId, limit }, signal);
    return (Array.isArray(list) ? list : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  }
}
