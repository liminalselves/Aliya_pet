import { mskStorageKey } from './config';

export const CONTROL_REQUEST_KEY = mskStorageKey('aliya_control_request');
export interface ControlRequest {
  sessionId: string;
  action: 'navigate' | 'refresh' | 'deleted' | 'replay';
  messageId?: string;
  divider?: boolean;
  at: number;
}
export function readControlRequest(storage?: Pick<Storage, 'getItem'>): ControlRequest | null {
  try {
    const value = JSON.parse(storage?.getItem(CONTROL_REQUEST_KEY) ?? 'null');
    if (!value || typeof value.sessionId !== 'string' || !['navigate', 'refresh', 'deleted', 'replay'].includes(value.action)
      || typeof value.at !== 'number' || Date.now() - value.at > 300_000) return null;
    if (['navigate', 'replay'].includes(value.action) && (typeof value.messageId !== 'string' || !value.messageId)) return null;
    return value;
  } catch { return null; }
}
