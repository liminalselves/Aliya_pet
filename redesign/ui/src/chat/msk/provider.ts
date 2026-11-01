import type { ChatEvent, ChatProvider, ChatRequest } from '../types';
import { MskClient } from './client';
import { performanceRequestPayload } from '../performance-manifest';

export class MskChatProvider implements ChatProvider {
  readonly label = 'Aliya';
  private pending: { text: string; fileId: string | null; id: string } | null = null;
  constructor(private readonly client: MskClient, readonly sessionId: string) {}
  async *reply({ messages, signal }: ChatRequest): AsyncIterable<ChatEvent> {
    const last = messages[messages.length - 1];
    const text = last?.text ?? '';
    const fileId = last?.file?.id ?? null;
    if ((!text.trim() && !fileId) || signal.aborted) return;
    // A failed HTTP attempt may already have been persisted upstream.
    if (!this.pending || this.pending.text !== text || this.pending.fileId !== fileId) this.pending = { text, fileId, id: crypto.randomUUID() };
    // 携带表演清单 = 桌宠环境：服务端注入表演协议，回复内嵌 [[agent_cue]] 指令由渲染层解析
    const answer = await this.client.send(this.sessionId, text, signal, this.pending.id, 2500, performanceRequestPayload(), fileId);
    if (signal.aborted) return;
    this.pending = null;
    yield { type: 'segment', id: answer.messageId, messageId: answer.messageId, text: answer.text };
    yield { type: 'done' };
  }
}
