/**
 * MSK 消息渲染的对外契约。
 * 依据 Aliya_web/js/index.js（占位图、附件、心率）与 liminalselves/misskey
 * packages/frontend/src/pages/chat/agent-session.message.vue（贴纸、全站表情、
 * 正则显示规则、分段、生图状态机）整理。
 */

export type ChatRole = 'user' | 'assistant';

/** agents/characters/show 返回的 regexRules；客户端只应用 hide 效果，aiInvisible 仅作用于 LLM 上下文。 */
export interface AgentRegexRule {
  id: string;
  pattern: string;
  targets: ReadonlyArray<'user' | 'assistant'>;
  effects: ReadonlyArray<'hide' | 'aiInvisible'>;
}

/** MSK DriveFile 的展示字段子集（timeline 的 message.file、sessions/show 的 characterStickers[].file）。 */
export interface DriveFileLike {
  id?: string;
  url?: string | null;
  thumbnailUrl?: string | null;
  type?: string | null;
}

/** 角色专属表情包（agents/sessions/show 的 characterStickers）。 */
export interface CharacterSticker {
  key: string;
  file: DriveFileLike | null;
}

/** 全站自定义表情（POST /api/emojis 的 EmojiSimple 子集）。 */
export interface CustomEmojiInfo {
  name: string;
  url?: string | null;
}

/** agents/images/generate-placeholder 与 agents/images/placeholder-status 的返回子集。 */
export interface GeneratePlaceholderResult {
  id?: string;
  status?: 'pending' | 'generating' | 'succeeded' | 'failed' | 'blocked' | 'deleted' | 'auto_cleaned' | string;
  fileId?: string | null;
  url?: string | null;
  /** Aliya_web 兼容回退：上游可能在 thumbnailUrl 提供可展示地址。 */
  thumbnailUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  tag?: string;
  size?: string;
  isBlocked?: boolean;
}

/**
 * MSK API 调用回调：endpoint 不带斜杠前缀（如 'agents/images/generate-placeholder'），
 * token 与错误处理由适配器负责（见 createMskApiCaller）。
 */
export type MskApiCaller = <T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

export interface RenderContext {
  /** MSK API 调用通道（占位图生成/状态查询都经过它）。 */
  api: MskApiCaller;
  /** 外链点击回调；桌宠 webview 内绝不自行导航。 */
  openUrl?: (url: string) => void;
  /** 图片点击回调（附件图、贴纸、生成的配图），用于放大预览。 */
  onImageClick?: (url: string) => void;
  /** [[heart_rate:min,max]] 指令回调；指令本身不会出现在展示文本里。 */
  onHeartRate?: (range: { min: number; max: number }) => void;
  /** 角色贴纸解析（来自 sessions/show 的 characterStickers）；未提供时贴纸记号保持字面文本。 */
  resolveSticker?: (key: string) => DriveFileLike | undefined;
  /** 显式开关贴纸渲染；默认由是否提供 resolveSticker 推断。 */
  stickersEnabled?: boolean;
  /** 全站表情静态表；与 loadEmojis 二选一。 */
  emojis?: ReadonlyArray<CustomEmojiInfo>;
  /** 全站表情懒加载（可用 fetchCustomEmojis(api) 实现）；失败时表情记号保持字面文本。 */
  loadEmojis?: (signal?: AbortSignal) => Promise<ReadonlyArray<CustomEmojiInfo>>;
  /** 显示用正则规则（可用 fetchRegexRules(api, characterId) 拉取）。 */
  regexRules?: ReadonlyArray<AgentRegexRule>;
  /** 自动生图开关，默认 true。 */
  autoDraw?: boolean;
  /** 单条消息自动生图张数上限，默认不限。 */
  autoDrawCount?: number;
  /** 会话是否已配置生图模型；false 时占位符全部进入待手动生成。 */
  drawModelReady?: boolean;
}

export interface RenderMessageInput {
  sessionId: string;
  messageId: string;
  text: string;
  role: ChatRole;
  /** 用户消息附图（timeline 的 message.file）。 */
  file?: DriveFileLike | null;
  /** 该消息是否为本次在线期间新到达；历史消息只查询已有生图记录，不触发生成。 */
  liveArrived?: boolean;
  /** 会话开启了分段输出（仅 assistant 生效）。 */
  segmented?: boolean;
  /** 取消本次渲染：停止后续网络请求与界面更新。 */
  signal?: AbortSignal;
  /** 每次界面 HTML 变化回调；最后一次调用即 settled 的兑现值。 */
  onUpdate?: (html: string) => void;
}
