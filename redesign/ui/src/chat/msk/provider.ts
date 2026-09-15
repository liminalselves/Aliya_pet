import type { ChatEvent, ChatProvider, ChatRequest, PerformanceCue } from '../types';
import { MskClient } from './client';

export function localCue(text: string): PerformanceCue | undefined {
  if (/开心|太好了|嘿嘿|哈哈|高兴/.test(text)) return { expression: 'happy' };
  if (/害羞|脸红|不好意思/.test(text)) return { expression: 'shy' };
  if (/抱歉|对不起|担心|没事吧/.test(text)) return { expression: 'worried' };
  return undefined;
}

export class MskChatProvider implements ChatProvider {
  readonly label = 'Aliya';
  private pending: { text: string; id: string } | null = null;
  constructor(private readonly client: MskClient, readonly sessionId: string) {}
  async *reply({ messages, signal }: ChatRequest): AsyncIterable<ChatEvent> {
    const text = messages[messages.length - 1]?.text ?? '';
    if (!text.trim() || signal.aborted) return;
    // A failed HTTP attempt may already have been persisted upstream.
    if (!this.pending || this.pending.text !== text) this.pending = { text, id: crypto.randomUUID() };
    const answer = await this.client.send(this.sessionId, text, signal, this.pending.id);
    if (signal.aborted) return;
    this.pending = null;
    yield { type: 'segment', id: answer.messageId, messageId: answer.messageId, text: answer.text, cue: localCue(answer.text) };
    yield { type: 'done' };
  }
}
