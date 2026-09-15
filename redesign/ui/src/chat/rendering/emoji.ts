/**
 * 图片地址与全站表情：
 * - 贴纸展示 URL 规则与 misskey stickerUrl 一致（动图保原图，其余优先缩略图）；
 * - 附件图规则与 Aliya_web timelineAttachmentImageUrls 一致（timeline 可能省略 type，
 *   此时仍以图片 URL 作为兼容回退）；
 * - 全站表情来自 POST /api/emojis（EmojiSimple：name + url）。
 */
import type { CharacterSticker, CustomEmojiInfo, DriveFileLike, MskApiCaller } from './types';

export function stickerImageUrl(file: DriveFileLike | null | undefined): string | null {
  if (!file) return null;
  const url = file.type === 'image/gif' || file.type === 'image/apng' ? file.url : (file.thumbnailUrl ?? file.url);
  return typeof url === 'string' && url !== '' ? url : null;
}

/** 附件消息可展示时返回图片地址；非图片类型且带 type 的返回 null。 */
export function attachmentImageUrl(file: DriveFileLike | null | undefined): string | null {
  if (!file || typeof file !== 'object') return null;
  const type = String(file.type ?? '').toLowerCase();
  const url = file.url || file.thumbnailUrl;
  if (!url || (type && !type.startsWith('image/'))) return null;
  return url;
}

export function normalizeEmojiList(raw: unknown): CustomEmojiInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomEmojiInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.name !== 'string' || value.name === '') continue;
    out.push({ name: value.name, url: typeof value.url === 'string' ? value.url : null });
  }
  return out;
}

export function buildEmojiMap(list: ReadonlyArray<CustomEmojiInfo>): Map<string, CustomEmojiInfo> {
  const map = new Map<string, CustomEmojiInfo>();
  for (const emoji of list) map.set(emoji.name, emoji);
  return map;
}

/** 拉取本站全站表情表（公开接口，无需凭证）。 */
export async function fetchCustomEmojis(api: MskApiCaller, signal?: AbortSignal): Promise<CustomEmojiInfo[]> {
  const data = await api<{ emojis?: unknown }>('emojis', {}, signal);
  return normalizeEmojiList(data?.emojis);
}

/** 清洗 agents/sessions/show 返回的 characterStickers（缺 file 或 key 的条目丢弃）。 */
export function normalizeCharacterStickers(raw: unknown): CharacterSticker[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterSticker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.key !== 'string' || value.key === '' || !value.file || typeof value.file !== 'object') continue;
    out.push({ key: value.key, file: value.file as DriveFileLike });
  }
  return out;
}

/** 拉取会话角色的专属表情包（与 LLM 视图同源）。 */
export async function fetchCharacterStickers(api: MskApiCaller, sessionId: string, signal?: AbortSignal): Promise<CharacterSticker[]> {
  const data = await api<{ characterStickers?: unknown }>('agents/sessions/show', { sessionId }, signal);
  return normalizeCharacterStickers(data?.characterStickers);
}

/** 由贴纸列表构造渲染器的 resolveSticker。 */
export function buildStickerResolver(list: ReadonlyArray<CharacterSticker>): (key: string) => DriveFileLike | undefined {
  const map = new Map<string, DriveFileLike>();
  for (const sticker of list) {
    if (sticker.file) map.set(sticker.key, sticker.file);
  }
  return key => map.get(key);
}
