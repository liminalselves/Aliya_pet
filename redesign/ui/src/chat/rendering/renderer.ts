/**
 * MSK 消息异步渲染器：组合正则显示规则、心率指令、展示分段、贴纸/全站表情、
 * 生图占位符状态机与 MFM+Markdown 正文，输出可直接 innerHTML 的安全 HTML。
 *
 * 生命周期与 misskey agent-session.message.vue 对齐：
 * - 在线新到的消息（liveArrived）自动生图；历史消息只查询已有记录，查不到转「待手动生成」；
 * - 关闭自动生图、超过张数上限或未配置生图模型时进入待手动生成；
 * - AGENT_IMAGE_DISABLED / AGENT_IMAGE_NOT_CONFIGURED 回退待手动；
 * - 生成成功展示图片并可重新生成，失败/封禁/清理/删除展示对应文案。
 *
 * 取消：input.signal 或 cancel() 触发后停止网络请求与界面更新，
 * settled 以当前 HTML 兑现，不会悬挂。
 */
import { composeMessage, type ComposedMessage, type DrawPartInfo } from './compose';
import { apiErrorCode, drawImageUrl, drawStatusText, drawViewOf, fetchPlaceholderStatus, generatePlaceholder, isDrawUnavailableCode } from './draw';
import { escapeAttr, safeHttpUrl } from './esc';
import { buildEmojiMap } from './emoji';
import { ensureMskStyles } from './styles';
import type { CustomEmojiInfo, GeneratePlaceholderResult, RenderContext, RenderMessageInput } from './types';

export interface MskRendered {
  /** 当前 HTML 快照（随时可写入 innerHTML）。 */
  readonly html: string;
  /** 全部生图状态落定（或被取消）后兑现最终 HTML。 */
  readonly settled: Promise<string>;
  /**
   * 绑定到容器：立即写入当前 HTML，后续状态变化自动刷新，
   * 并接管点击——外链回调 openUrl、图片回调 onImageClick、生图按钮动作。
   * 同一容器重复调用安全（监听只挂一次）。
   */
  bind(container: HTMLElement): void;
  /** 停止本次渲染的后续网络与更新。 */
  cancel(): void;
}

interface DrawRuntime {
  info: DrawPartInfo;
  result: GeneratePlaceholderResult | null;
  /** 待手动生成（尚未生成或生图不可用）。 */
  parked: boolean;
  /** 网络请求进行中。 */
  busy: boolean;
  /** 该占位符的异步流程已结束。 */
  done: boolean;
}

const EMPTY_EMOJI: Map<string, CustomEmojiInfo> = new Map();

class RenderTask implements MskRendered {
  private readonly controller = new AbortController();
  private readonly runtimes = new Map<number, DrawRuntime>();
  private readonly boundContainers = new Set<HTMLElement>();
  private readonly boundOnce = new WeakSet<HTMLElement>();
  private composed: ComposedMessage | null = null;
  private currentHtml = '';
  private pendingOps = 0;
  private aborted = false;
  private finished = false;
  private resolveSettled!: (html: string) => void;
  readonly settled: Promise<string>;

  constructor(
    private readonly renderer: MskMessageRenderer,
    private readonly input: RenderMessageInput,
  ) {
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
    const external = input.signal;
    if (external) {
      if (external.aborted) this.abort();
      else external.addEventListener('abort', () => this.abort(), { once: true });
    }
    void this.start();
  }

  get html(): string { return this.currentHtml; }

  cancel(): void { this.abort(); }

  bind(container: HTMLElement): void {
    if (this.aborted && !this.composed) return;
    ensureMskStyles(container.ownerDocument);
    container.innerHTML = this.currentHtml;
    this.boundContainers.add(container);
    if (!this.boundOnce.has(container)) {
      this.boundOnce.add(container);
      container.addEventListener('click', this.onContainerClick);
    }
  }

  private readonly onContainerClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const action = target.closest<HTMLElement>('[data-msk-action]');
    if (action) {
      event.preventDefault();
      const index = Number(action.getAttribute('data-msk-draw-index'));
      const runtime = this.runtimes.get(Number.isFinite(index) ? index : NaN);
      if (!runtime || runtime.busy) return;
      if (action.getAttribute('data-msk-action') === 'retry') void this.generate(runtime, true);
      else void this.generate(runtime, false);
      return;
    }
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      // 外链一律交给宿主回调，绝不在桌宠 webview 内导航。
      event.preventDefault();
      this.renderer.context.openUrl?.(anchor.getAttribute('href') || '');
      return;
    }
    const zoom = target.closest<HTMLImageElement>('img.msk-zoom');
    if (zoom) {
      const src = zoom.getAttribute('src');
      if (src) this.renderer.context.onImageClick?.(src);
    }
  };

  private abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.controller.abort();
    for (const runtime of this.runtimes.values()) {
      // 网络中止后由各自的 catch/finally 收尾；此处先标记，避免新的动作再发起请求。
      if (!runtime.busy) runtime.done = true;
    }
    this.settleIfIdle();
  }

  private get signal(): AbortSignal { return this.controller.signal; }

  private async start(): Promise<void> {
    const emojiMap = await this.renderer.ensureEmojiMap(this.signal);
    if (this.aborted) { this.finish(); return; }
    const ctx = this.renderer.context;
    this.composed = composeMessage(this.input.text ?? '', {
      role: this.input.role,
      showGeneratedImages: ctx.showGeneratedImages,
      stickersEnabled: ctx.stickersEnabled ?? typeof ctx.resolveSticker === 'function',
      resolveSticker: ctx.resolveSticker,
      resolveEmoji: (name) => {
        const emoji = emojiMap.get(name);
        return emoji && emoji.url ? emoji : undefined;
      },
      segmented: this.input.segmented === true,
      regexRules: ctx.regexRules,
      file: this.input.file,
    });
    for (const info of this.composed.draws) {
      this.runtimes.set(info.index, { info, result: null, parked: false, busy: false, done: false });
    }
    if (this.composed.heartRate) this.renderer.context.onHeartRate?.(this.composed.heartRate);
    if (this.composed.heartRate === undefined && this.runtimes.size === 0) {
      // 无生图占位符：一次 emit 即终态
      this.emit();
      this.finish();
      return;
    }
    this.emit();
    this.startDraws();
    this.settleIfIdle();
  }

  /** misskey startDraws 的分流策略。 */
  private startDraws(): void {
    const ctx = this.renderer.context;
    if (this.input.role !== 'assistant') {
      for (const runtime of this.runtimes.values()) runtime.done = true;
      return;
    }
    const autoDraw = ctx.autoDraw !== false;
    const limit = ctx.autoDrawCount ?? Number.POSITIVE_INFINITY;
    for (const runtime of this.runtimes.values()) {
      if (this.aborted) return;
      if (ctx.drawModelReady === false) { this.park(runtime); continue; }
      if (autoDraw && runtime.info.index < limit) {
        if (this.input.liveArrived === true) void this.generate(runtime, false);
        else void this.checkExisting(runtime);
      } else {
        void this.checkExisting(runtime);
      }
    }
  }

  /** 查询服务端已有记录；无记录转待手动生成，避免历史占位符被批量触发生成。 */
  private async checkExisting(runtime: DrawRuntime): Promise<void> {
    if (this.aborted || runtime.busy || runtime.result || runtime.parked) { this.settleIfIdle(); return; }
    this.pendingOps++;
    try {
      const result = await fetchPlaceholderStatus(this.renderer.context.api, {
        sessionId: this.input.sessionId,
        messageId: this.input.messageId,
        placeholderIndex: runtime.info.index,
      }, this.signal);
      if (this.aborted) return;
      if (runtime.result || runtime.parked || runtime.busy) return;
      if (result) runtime.result = result;
      else runtime.parked = true;
      this.emit();
    } catch {
      if (!this.aborted && !runtime.result && !runtime.parked) {
        runtime.parked = true;
        this.emit();
      }
    } finally {
      this.pendingOps--;
      runtime.done = true;
      this.settleIfIdle();
    }
  }

  private park(runtime: DrawRuntime): void {
    if (!runtime.result) runtime.parked = true;
    runtime.done = true;
    this.emit();
  }

  private async generate(runtime: DrawRuntime, regenerate: boolean): Promise<void> {
    if (this.aborted || runtime.busy) return;
    runtime.parked = false;
    runtime.busy = true;
    runtime.done = false;
    this.emit();
    this.pendingOps++;
    const previousId = runtime.result?.id;
    const regenerationOfId = regenerate && previousId && !previousId.includes(':') ? previousId : null;
    try {
      try {
        const result = await generatePlaceholder(this.renderer.context.api, {
          sessionId: this.input.sessionId,
          messageId: this.input.messageId,
          placeholderIndex: runtime.info.index,
        }, { regenerate, regenerationOfId }, this.signal);
        if (!this.aborted) {
          runtime.result = result;
          const code = typeof result.errorCode === 'string' ? result.errorCode : '';
          if (!regenerate && isDrawUnavailableCode(code)) {
            // 生图模型未启用/未配置：回到待手动，不落失败态
            runtime.result = null;
            runtime.parked = true;
          }
        }
      } catch (e) {
        if (!this.aborted) {
          const code = apiErrorCode(e);
          if (!regenerate && isDrawUnavailableCode(code)) {
            runtime.result = null;
            runtime.parked = true;
          } else {
            runtime.result = {
              ...runtime.result,
              status: 'failed',
              errorCode: code || null,
              errorMessage: e instanceof Error ? e.message : null,
            };
          }
        }
      }
      // 先复位 busy 再输出，保证界面显示的是最终状态而不是加载态。
      runtime.busy = false;
      this.emit();
    } finally {
      runtime.busy = false;
      runtime.done = true;
      this.pendingOps--;
      this.settleIfIdle();
    }
  }

  private stateHtml(runtime: DrawRuntime): string {
    const retryButton = `<div class="msk-draw-foot"><button type="button" class="msk-draw-btn" data-msk-action="retry" data-msk-draw-index="${runtime.info.index}"${runtime.busy ? ' disabled' : ''}>重新生成</button></div>`;
    if (runtime.busy) {
      return `<div class="msk-draw-state"><span class="msk-draw-spinner" aria-hidden="true"></span> 图片生成中...</div>`;
    }
    if (runtime.result) {
      const view = drawViewOf(runtime.result);
      if (view === 'image') {
        const url = safeHttpUrl(drawImageUrl(runtime.result));
        if (url) {
          return `<img class="msk-draw-image msk-zoom" src="${escapeAttr(url)}" alt="配图" loading="lazy">` + retryButton;
        }
      }
      if (view === 'loading') {
        return `<div class="msk-draw-state"><span class="msk-draw-spinner" aria-hidden="true"></span> 图片生成中...</div>`;
      }
      if (view === 'failed') {
        return `<div class="msk-draw-state msk-draw-error">${escapeText(drawStatusText(runtime.result))}</div>` + retryButton;
      }
      return `<div class="msk-draw-state">${escapeText(drawStatusText(runtime.result))}</div>`;
    }
    if (runtime.parked) {
      return `<div class="msk-draw-state">尚未生成</div>`
        + `<div class="msk-draw-foot"><button type="button" class="msk-draw-btn" data-msk-action="generate" data-msk-draw-index="${runtime.info.index}">立即生成</button></div>`;
    }
    return `<div class="msk-draw-state">图片生成中...</div>`;
  }

  private buildHtml(): string {
    const composed = this.composed;
    if (!composed) return '';
    let html = composed.html;
    if (this.runtimes.size > 0) {
      for (const [index, runtime] of this.runtimes) {
        html = html.split(`\u0000${index}\u0000`).join(this.stateHtml(runtime));
      }
    }
    return html;
  }

  private emit(): void {
    if (this.aborted || !this.composed) return;
    this.currentHtml = this.buildHtml();
    // 先写绑定容器再回调：onUpdate 里读取 DOM（如 GAL 分页重排）必须看到本次新元素。
    for (const container of this.boundContainers) container.innerHTML = this.currentHtml;
    this.input.onUpdate?.(this.currentHtml);
  }

  private settleIfIdle(): void {
    if (this.finished) return;
    if (this.aborted || this.pendingOps === 0) {
      for (const runtime of this.runtimes.values()) {
        if (!runtime.busy) runtime.done = true;
      }
      this.finish();
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.renderer.forget(this);
    this.resolveSettled(this.currentHtml);
  }
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class MskMessageRenderer {
  private emojiMap: Map<string, CustomEmojiInfo> | null = null;
  private emojiLoad: Promise<Map<string, CustomEmojiInfo>> | null = null;
  private readonly tasks = new Set<RenderTask>();

  constructor(readonly context: RenderContext) {}

  /** 渲染一条消息；同一渲染器可并发渲染多条，互不干扰。 */
  render(input: RenderMessageInput): MskRendered {
    const task = new RenderTask(this, input);
    this.tasks.add(task);
    return task;
  }

  /** 取消本渲染器所有进行中的渲染。 */
  cancelAll(): void {
    for (const task of [...this.tasks]) task.cancel();
  }

  /** @internal */
  forget(task: RenderTask): void {
    this.tasks.delete(task);
  }

  /** @internal 全站表情表就绪：静态表优先，其次懒加载并缓存，失败回退空表（表情记号保持字面文本）。 */
  async ensureEmojiMap(signal: AbortSignal): Promise<Map<string, CustomEmojiInfo>> {
    const ctx = this.context;
    if (ctx.emojis) return buildEmojiMap(ctx.emojis);
    if (this.emojiMap) return this.emojiMap;
    if (!ctx.loadEmojis) return EMPTY_EMOJI;
    if (!this.emojiLoad) {
      this.emojiLoad = ctx.loadEmojis(signal)
        .then(list => {
          const map = buildEmojiMap(list);
          this.emojiMap = map;
          return map;
        })
        .catch(() => {
          this.emojiLoad = null;
          return EMPTY_EMOJI;
        });
    }
    return this.emojiLoad;
  }
}
