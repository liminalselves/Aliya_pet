import type { ChatMessage, ChatProvider, PerformanceCue } from './types';

const STORAGE_KEY = 'aliya_chat_v1';
const MAX_MESSAGES = 60;
const MAX_TEXT = 12000;

export interface ChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 请求、取消和本地记录。所有异步事件都必须属于当前请求。 */
export class ChatController {
  readonly messages: ChatMessage[] = [];
  busy = false;
  error = '';
  onChange: () => void = () => {};
  onCue: (cue: PerformanceCue) => void = () => {};
  onCancelPerformance: () => void = () => {};
  private _request: AbortController | null = null;
  private _sequence = 0;
  private _provider: ChatProvider;
  /** 本地持久化开关：MSK 模式下历史以服务器时间线为准，不写 localStorage。 */
  persist: boolean;

  constructor(provider: ChatProvider, private readonly storage?: ChatStorage) {
    this._provider = provider;
    this.persist = !!storage;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(saved)) return;
      for (const m of saved.slice(-MAX_MESSAGES)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') continue;
        this.messages.push({ id: this.id(), role: m.role, text: m.text.slice(0, MAX_TEXT),
          status: m.role === 'user' || m.status === 'complete' ? 'complete' : 'stopped' });
      }
    } catch { /* 存储不可用或损坏时仍能聊天。 */ }
  }

  get provider(): ChatProvider { return this._provider; }

  /** 切换对话来源（演示 → MSK）。打断进行中的请求并清空演示消息。 */
  useProvider(provider: ChatProvider, keepMessages = false): void {
    this.stop();
    this._provider = provider;
    if (!keepMessages) this.messages.length = 0;
    this.error = '';
    this.changed();
  }

  /** 用外部历史（如 MSK 时间线）整体替换本地记录。 */
  replaceHistory(list: ChatMessage[]): void {
    this.stop();
    this.messages.length = 0;
    for (const m of list.slice(-MAX_MESSAGES)) {
      this.messages.push({ ...m, id: m.id || this.id(), text: String(m.text ?? ''), status: 'complete' });
    }
    this.changed();
  }

  private id(): string { return `${Date.now()}-${++this._sequence}`; }

  get latest(): ChatMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  get canRetry(): boolean {
    return !this.busy && this.latest?.role === 'assistant' &&
      (this.latest.status === 'error' || this.latest.status === 'stopped');
  }

  async send(input: string): Promise<void> {
    const text = input.trim();
    if (!text || text.length > 2000) return;
    this.stop();
    this.messages.push({ id: this.id(), role: 'user', text, status: 'complete' });
    // 保留完整轮次，从最早的 user 开始；不把过期片段混入新请求。
    if (this.messages.length > MAX_MESSAGES - 1) this.messages.splice(0, 2);
    await this.generate();
  }

  async retry(): Promise<void> {
    if (!this.canRetry) return;
    this.messages.pop();
    await this.generate();
  }

  stop(): void {
    this._request?.abort();
    this._request = null;
    if (this.busy && this.latest?.role === 'assistant') this.latest.status = 'stopped';
    this.busy = false;
    this.onCancelPerformance();
    this.changed();
  }

  private async generate(): Promise<void> {
    const request = new AbortController();
    this._request = request;
    const context = this.messages.filter(m => m.role === 'user' || m.status === 'complete')
      .map(({ role, text }) => ({ role, text }));
    const answer: ChatMessage = { id: this.id(), role: 'assistant', text: '', status: 'pending' };
    this.messages.push(answer);
    this.error = '';
    this.busy = true;
    this.changed();
    const seen = new Set<string>();
    try {
      let done = false;
      for await (const event of this.provider.reply({ messages: context, signal: request.signal })) {
        if (request.signal.aborted || this._request !== request) return;
        if (event.type === 'done') { done = true; break; }
        if (event.type !== 'segment' || typeof event.text !== 'string' || seen.has(event.id)) continue;
        seen.add(event.id);
        if (answer.text.length + event.text.length > MAX_TEXT) throw new Error('回复过长');
        if (event.messageId) answer.messageId = event.messageId;
        answer.text += (answer.text ? '\n\n' : '') + event.text;
        this.changed();
      }
      if (request.signal.aborted || this._request !== request) return;
      if (!done || !answer.text.trim()) throw new Error('回复未完成');
      answer.status = 'complete';
    } catch (e) {
      if (request.signal.aborted || this._request !== request) return;
      answer.status = 'error';
      // 透传客户端已翻译好的具体原因（余额不足/回复 pending/审核拦截等），只兜底未知错误。
      this.error = e instanceof Error && e.message ? e.message : '这次没能完成回复。内容已保留，可以重试。';
      this.onCancelPerformance();
    } finally {
      if (this._request === request) {
        this._request = null;
        this.busy = false;
        this.changed();
      }
    }
  }

  private changed(): void {
    if (this.persist) {
      try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.messages)); } catch { /* 可继续本次对话。 */ }
    }
    this.onChange();
  }
}
