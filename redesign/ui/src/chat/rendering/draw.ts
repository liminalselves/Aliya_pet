/**
 * 生图占位符 API 与状态文案。
 * 上游契约来自 agents/images/generate-placeholder、agents/images/placeholder-status；
 * 错误文案与 misskey agent-session.message.vue 的 drawErrorText/drawStatusText 对齐，
 * 图片地址回退（url → thumbnailUrl）与 Aliya_web 的 fetchPlaceholderImage 一致。
 */
import type { GeneratePlaceholderResult, MskApiCaller } from './types';

export interface DrawTarget {
  sessionId: string;
  messageId: string;
  placeholderIndex: number;
}

/** 生成/重新生成一张占位图（同步等待上游结果，超时由适配器控制）。 */
export async function generatePlaceholder(
  api: MskApiCaller,
  target: DrawTarget,
  options: { regenerate?: boolean; regenerationOfId?: string | null },
  signal?: AbortSignal,
): Promise<GeneratePlaceholderResult> {
  return api<GeneratePlaceholderResult>('agents/images/generate-placeholder', {
    sessionId: target.sessionId,
    messageId: target.messageId,
    placeholderIndex: target.placeholderIndex,
    regenerate: options.regenerate === true,
    regenerationOfId: options.regenerationOfId ?? null,
  }, signal);
}

/** 查询服务端已有生图记录；无记录时返回 null。 */
export async function fetchPlaceholderStatus(api: MskApiCaller, target: DrawTarget, signal?: AbortSignal): Promise<GeneratePlaceholderResult | null> {
  const data = await api<GeneratePlaceholderResult | null>('agents/images/placeholder-status', {
    sessionId: target.sessionId,
    messageId: target.messageId,
    placeholderIndex: target.placeholderIndex,
  }, signal);
  return data && typeof data === 'object' ? data : null;
}

/** 展示地址：优先原图，缺失时回退缩略图；被封禁/清理的结果上游不给地址。 */
export function drawImageUrl(result: GeneratePlaceholderResult | null | undefined): string | null {
  const url = result?.url || result?.thumbnailUrl;
  return typeof url === 'string' && url !== '' ? url : null;
}

export function isDrawBlocked(result: GeneratePlaceholderResult | null | undefined): boolean {
  return result?.status === 'blocked' || result?.isBlocked === true;
}

/** 错误码 → 中文文案（与 misskey 一致）。 */
export function drawErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'AGENT_IMAGE_NO_FREE_DRIVE_SPACE': return '网盘空间不足，无法保存生成图片';
    case 'AGENT_IMAGE_MAX_FILE_SIZE_EXCEEDED': return '图片超过账号允许的最大文件大小';
    case 'AGENT_IMAGE_UNALLOWED_FILE_TYPE': return '图片文件类型不允许上传';
    case 'AGENT_IMAGE_INSUFFICIENT_CREDIT': return '智能体额度不足';
    case 'AGENT_IMAGE_DISABLED': return '生图模型未启用';
    case null:
    case '':
    case undefined: return '生成失败';
    default: return code;
  }
}

/** 结果状态 → 展示状态（'ok' 表示有图可展示）。 */
export type DrawView = 'loading' | 'image' | 'blocked' | 'cleaned' | 'deleted' | 'failed';

export function drawViewOf(result: GeneratePlaceholderResult | null | undefined): DrawView {
  if (!result) return 'loading';
  if (isDrawBlocked(result)) return 'blocked';
  if (result.status === 'auto_cleaned') return 'cleaned';
  if (result.status === 'deleted') return 'deleted';
  if (result.status === 'succeeded' && drawImageUrl(result)) return 'image';
  if (result.status === 'failed') return 'failed';
  return 'loading';
}

/** 非成功状态下的说明文字。 */
export function drawStatusText(result: GeneratePlaceholderResult): string {
  if (isDrawBlocked(result)) return '图片已被审核封禁';
  if (result.status === 'auto_cleaned') return '图片已自动清理';
  if (result.status === 'deleted') return '图片已删除';
  if (result.status === 'failed') return `生成失败：${drawErrorText(result.errorCode)}`;
  return '图片生成中...';
}

/** 从 API 适配器抛出的错误里取服务端错误码（适配器负责附加 code 字段）。 */
export function apiErrorCode(error: unknown): string {
  if (error != null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/** 自动生图不可用（模型为「无」或未配置）时回退待手动，与 misskey 一致。 */
export function isDrawUnavailableCode(code: string): boolean {
  return code === 'AGENT_IMAGE_DISABLED' || code === 'AGENT_IMAGE_NOT_CONFIGURED';
}
