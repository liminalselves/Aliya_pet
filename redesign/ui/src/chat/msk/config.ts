export const DEFAULT_MSK_ORIGIN = 'https://misskey.liminalselves.top';

export function normalizeMskOrigin(value = DEFAULT_MSK_ORIGIN): string {
  const url = new URL(value.trim() || DEFAULT_MSK_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VITE_MSK_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  }
  return url.origin;
}

export const MSK_BASE = normalizeMskOrigin(import.meta.env.VITE_MSK_ORIGIN ?? DEFAULT_MSK_ORIGIN);

export function mskStorageKey(key: string): string {
  // The default instance owns the existing unqualified keys.
  return MSK_BASE === DEFAULT_MSK_ORIGIN ? key : `${key}@${MSK_BASE}`;
}

export const MSK_TOKEN_KEY = mskStorageKey('aliya_msk_token');
export const MSK_USER_KEY = mskStorageKey('aliya_msk_user');
export const MSK_PENDING_KEY = mskStorageKey('aliya_miauth_pending');
export const mskSessionKey = (userId: string): string => mskStorageKey(`aliya_session:${userId}`);
