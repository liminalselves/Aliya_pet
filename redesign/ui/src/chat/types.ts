/** 桌宠内部协议；MSK 的 HTTP/流格式以后由 Provider 转换，不泄漏进界面。 */
export interface PerformanceCue {
  expression?: string;
  action?: string;
}

export type ChatEvent =
  | { type: 'segment'; id: string; text: string; cue?: PerformanceCue; messageId?: string }
  | { type: 'done' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  messageId?: string;
  file?: import('./rendering/types').DriveFileLike | null;
  status: 'complete' | 'pending' | 'stopped' | 'error';
}

export interface ChatRequest {
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'text'>>;
  signal: AbortSignal;
}

export interface ChatProvider {
  readonly label: string;
  reply(request: ChatRequest): AsyncIterable<ChatEvent>;
}
