import { ChatController, type ChatStorage } from './chat/controller';
import { MskAuth } from './chat/msk/auth';
import { ChatBackgroundLayer } from './chat-background';
import { ChatView } from './chat/view';
import { ChatPerformance } from './chat/performance';
import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { PetModel } from './pet-model';
import { InteractionCoordinator, type SpeechSource } from './interaction/coordination';
import { DialogueStore, type ResolvedDialogue } from './dialogue/dialogue';
import { DialogueBubble } from './dialogue/bubble';
import { HitAreas } from './interaction/hit-areas';
import { showStartupNotice } from './startup-notice';
import { InteractionService } from './interaction/interaction';
import { PointerContext } from './interaction/petting-recognizer';
import { BehaviorService } from './behavior';
import { MoodEngine } from './emotion';
import { PetAI } from './pet-ai';
import {
  PetSettings,
  clampScale,
  loadSettings,
  nextSizePreset,
  saveSettings,
} from './settings';
import {
  platform,
  androidShell,
  isAndroidOverlay,
} from './platform';

/** Tauri 窗口句柄（浏览器环境为 null，拖动退化为不可用）。 */
type TauriWindow = import('@tauri-apps/api/window').Window;
type ShellAction = { action: string; value?: boolean; name?: string; duration?: number };

/**
 * 应用外壳：WebGL 画布、渲染循环（帧率上限）、模型装配与投影、
 * 指针输入接线（右键抚摸 / 左键点击 / 左键拖动窗口）、对话气泡与行为服务。
 *
 * 桌宠场景与官方 Demo 的差异：
 * - 窗口透明：clearColor(0,0,0,0)，无背景精灵。
 * - 帧率上限（?fps=N，默认 30）：空闲状态降低 CPU 占用。
 * - 窗口拖动为手动实现（setPosition 增量移动）：Tauri 原生 startDragging
 *   的模态循环会吞掉后续指针事件，快速拖动反应链需要完整事件流。
 * - 抚摸仅右键（Windows 约定），左键留给拖动/单击。
 */
export class PetApp {
  private _canvas: HTMLCanvasElement = null;
  private _gl: WebGL2RenderingContext = null;
  private _frameBuffer: WebGLFramebuffer = null;
  private _model: PetModel = null;
  private _running = false;
  private _lastFrameTime = 0;

  // 逻辑层
  private _dialogue = new DialogueStore();
  /** 监听先于资源加载；依赖模型/台词的操作在完整装配后按接收顺序执行。 */
  private _pendingShellActions: ShellAction[] = [];
  private _shellActionsReady = false;
  private _settingsSyncTask: Promise<void> | null = null;
  private _settingsSyncListeners = new Set<string>();
  private _shellSyncNotice: HTMLElement | null = null;
  private _hitAreas = new HitAreas();
  private _bubble: DialogueBubble = null;
  private _interaction: InteractionService = null;
  private _behavior: BehaviorService = null;
  private _moodEngine: MoodEngine = null;
  private _ai: PetAI = null;
  private _remoteChat = { open: false, busy: false, typing: false };
  private _chatLauncher: HTMLElement | null = null;
  /** 聊天入口当前 bottom 缓存（CSS px）：逐帧校正，值不变不写 style。 */
  private _launcherBottomCss = 0;
  /** 聊天入口当前缩放系数缓存（写入 --launcher-k）。 */
  private _launcherScaleK = 1;
  private _chat: ChatController | null = null;
  private _chatView: ChatView | null = null;
  private _chatPerformance: ChatPerformance | null = null;
  private _windowSettingsRevision = 0;
  /** 尺寸与位置必须成对完成；队列中尚未开始的旧请求可合并跳过。 */
  private _windowSettingsTask: Promise<void> = Promise.resolve();
  private _windowGeometryPending = 0;
  private _windowGeometryRevision = 0;
  private _windowPositionRevision = 0;
  private _windowPositionKind: 'move' | 'reset' = 'move';
  /** 原生 resize 已发生但补偿失败时保留债务；下一次用户操作先完成它，不盲目重试。 */
  private _windowResizeRecovery: ((publish?: boolean) => Promise<void>) | null = null;
  private _windowGeometryError: unknown = null;
  /** 保留原生窗口整数坐标舍去的亚像素，避免反复缩放累积漂移。 */
  private _windowResizeRemainder = { x: 0, y: 0 };
  private _coordination = new InteractionCoordinator(() => ({
    interacting: this._leftDown || this._dragging || this._nativeDragging || (this._interaction?.isBusy ?? false),
    speaking: this._remoteChat.busy || this._remoteChat.typing || (this._bubble?.isActive ?? false) || (this._chat?.busy ?? false) ||
      (this._chatView?.typing ?? false),
    paused: this._paused || !this._running,
  }));

  // Tauri 窗口拖动
  private _tauriWindow: TauriWindow | null = null;
  private _winPhysX = 0;
  private _winPhysY = 0;
  private _scaleFactor = 1;
  private _metricsSynced = false;
  private _chatAnchorRevision = 0;
  private _windowMoveTask: Promise<void> | null = null;

  /** 悬浮窗内容贴合模式：固定尺寸窗口 + 像素掩码穿透（透明区域不挡下层触摸）。 */
  private _wrapWindow = false;
  /** 模型原点的屏幕位置（CSS px），贴合模式的定位锚点。 */
  private _originCssX = 0;
  private _originCssY = 0;
  /** 内容渲染比例（CSS px / 模型单位）。 */
  private _contentScaleCss = 1;
  /** 已应用到壳的窗口矩形（CSS px）。 */
  private _appliedRectX = 0;
  private _appliedRectY = 0;
  private _appliedRectW = 0;
  private _appliedRectH = 0;
  private _rectInited = false;
  /** 固定矩形需要重算下发（缩放/模型加载/吸附动画驱动）。 */
  private _rectDirty = false;
  /** 壳侧屏幕尺寸缓存（CSS px；缩放与贴边共用，避免逐帧同步桥调用）。 */
  private _screenW = 0;
  private _screenH = 0;
  /** 吸附归位动画令牌：新拖动/新吸附自增打断旧动画。 */
  private _snapAnimToken = 0;
  /**
   * 缩放补间（CSS px / 模型单位）：外窗尺寸只能单步落定，角色大小在画布内以脚底为
   * 锚平滑过渡。start=null 表示保持 from（等原生尺寸落地再开始）；settled=窗口已落定，
   * 播完即撤销，回到按窗口自然适配。
   */
  private _scaleTween: { from: number; to: number; start: number | null; settled: boolean } | null = null;
  private static readonly _scaleTweenMs = 200;
  private _snapAnimation: Animation | null = null;
  private _snapHintTimer: ReturnType<typeof setTimeout> | null = null;
  private _globalMouse: { x: number; y: number } | null = null;
  private _dpr = 1;
  /** Windows 缩放补间状态（_runScaleAnimation）；target 随设置实时更新。 */
  private _scaleAnim: { target: number; running: boolean } | null = null;
  private _scaleAnimDone = 0;
  /** 缩放缓动时间常数（ms）：指数逼近，连续拖动滑杆时跟手、松手后柔和落定。 */
  private static readonly _scaleEaseMs = 55;
  private _chatLayoutWidth = 0;
  /** Android 主界面聊天背景层（悬浮窗不创建）。 */
  private _chatBackground: ChatBackgroundLayer | null = null;
  private _chatBackgroundKey = '';
  /** 悬浮窗原生贴边动画进行中（原点已是终点，窗口正由壳平移）。 */
  private _nativeSnapping = false;
  /** 悬浮窗壳正在原生拖动（窗口由壳独占，暂停矩形下发）。 */
  private _nativeDragging = false;
  /** WebGL 上下文已丢失（回前台后整页重建恢复）。 */
  private _glContextLost = false;

  // 鼠标穿透命中掩码（Windows 壳）：低频把渲染结果缩成占用表上报给 Rust
  private _hitMaskCanvas: HTMLCanvasElement | null = null;
  private _hitMaskCtx: CanvasRenderingContext2D | null = null;
  private _hitMaskData: Uint8Array = new Uint8Array(0);
  private _hitMaskRows = 0;
  private _hitMaskLastMs = 0;
  private _hitMaskSentMs = 0;
  private _hitMaskGeometry = '';
  private _hitMaskSend: ((args: Record<string, unknown>) => void) | null = null;
  private _hitMaskInteracting = false;

  // 设置
  private _settings: PetSettings = loadSettings();

  // 指针状态
  private _activePointerId: number | null = null;
  private _leftDown = false;
  private _dragCandidate = false;
  private _dragging = false;
  /** 触摸端：本次按下走抚摸通道（头部区域），松开事件需对应回传。 */
  private _touchPetting = false;
  private _touchTapCandidate = false;
  private _downScreenX = 0;
  private _downScreenY = 0;
  private _lastScreenX = 0;
  private _lastScreenY = 0;
  private _lastMoveEventMs = 0;

  /** 渲染暂停（屏幕熄灭/后台，由壳或 visibilitychange 触发）。 */
  private _paused = false;

  /** 拖动判定阈值（CSS px）。 */
  private static readonly _dragThresholdPx = 5;

  /** 松手贴边感应带（CSS px）。 */
  private static readonly _snapZonePx = 48;

  /**
   * 渲染动作余量：模型渲染尺寸 = 视口 / 1.30，不改变用户窗口缩放设置。
   * 正式 Core 的新动作×表情×极端注视/切换矩阵：需求 1.222872，
   * 乘 1.05 安全系数后需 1.284015，向上取 1.30（测量方法见 docs/ACTIONS.md）。
   */
  private static readonly _renderMarginRatio = 1.30;
  /** 聊天入口与脚底的固定间隙（CSS px）。 */
  private static readonly _launcherGapCss = 6;

  /** 窗口尺寸余量：窗口 = 675×scale × 1.18（对齐 Flutter ComputeTargetPixelSize）。 */
  private static readonly _windowMarginRatio = 1.18;

  /** 悬浮窗顶部永久预留的气泡带高度（CSS px，≈3 行气泡 + 间隙）。 */
  private static readonly _WRAP_BUBBLE_BAND = 88;

  /** 气泡适配缓存：文本/视口变化时重算等比缩放（见 _positionBubble）。 */
  private _bubbleFitKey = '';
  private _bubbleScaledH = 0;

  /** 鼠标穿透掩码列数（行数按窗口纵横比推导）。 */
  /** 原生穿透掩码列数：48 列时一格 ≈ 8 CSS px，头顶发梢旁的整格透明区也会被吞点击。 */
  private static readonly _hitMaskCols = 96;

  /** 掩码 alpha 阈值（0-255）：低于视为透明像素。 */
  private static readonly _hitMaskAlphaThreshold = 16;

  /** 帧率上限。URL 参数 ?fps=60 可调，默认 30（与待机行为一致）。 */
  private _fpsCap: number;
  /** URL/默认帧率（省电模式相对此值下调）。 */
  private readonly _baseFpsCap: number;

  public constructor() {
    const fps = Number(new URLSearchParams(location.search).get('fps'));
    this._baseFpsCap = fps > 0 ? fps : 30;
    this._fpsCap = this._baseFpsCap;
  }

  public initialize(): boolean {
    const stage = document.getElementById('stage');
    this._canvas = document.createElement('canvas');
    stage.appendChild(this._canvas);

    // 悬浮窗：窗口逐帧包裹角色剪影，透明区域不挡下层触摸（真穿透）。
    this._wrapWindow = isAndroidOverlay();
    // 气泡带样式钩子（顶部预留带 + 行数钳制，见 pet.css body.overlay-wrap）
    if (this._wrapWindow) document.body.classList.add('overlay-wrap');
    document.body.classList.toggle('android-main', platform === 'android' && !this._wrapWindow);

    this._gl = this._canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      // Live2D 边缘来自贴图 alpha，MSAA 几乎不起作用；移动端 dpr≥2 下多重采样
      // 是整屏填充率的主要开销之一，安卓关掉。
      antialias: platform !== 'android',
      // Windows 窗口缩放过程中系统会重合成上一帧：preserve=false 时呈现后缓冲失效，
      // 合成到的是黑/白闪帧；true 让旧帧被拉伸显示直到新一帧就绪。
      // Android 不缩放外窗，而保留缓冲在移动端分块 GPU 上每帧多一次整屏拷贝；
      // 悬浮窗命中掩码在 _render 同一任务内读取画布，不依赖保留缓冲。
      preserveDrawingBuffer: platform !== 'android',
    }) as WebGL2RenderingContext;
    if (!this._gl) {
      console.error('[pet] WebGL2 not available');
      return false;
    }
    this._frameBuffer = this._gl.getParameter(
      this._gl.FRAMEBUFFER_BINDING
    );

    // 触摸端：禁止浏览器把拖动识别为滚动手势（会 pointercancel 掉拖动/抚摸的事件流）
    this._canvas.style.touchAction = 'none';
    this._canvas.style.userSelect = 'none';
    this._canvas.style.webkitUserSelect = 'none';

    // WebGL 上下文丢失（Android 长时间后台表面被销毁）：
    // 纹理/着色器不可就地恢复，回前台后整页重建（位置/设置均已持久化）。
    this._canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // 允许系统触发 restored；统一走整页重建
      this._glContextLost = true;
    });
    this._canvas.addEventListener('webglcontextrestored', () => {
      this._reloadAfterContextLoss();
    });

    // 悬浮窗：模型就绪前先把窗口摆到正确位置/近似尺寸——
    // 服务一拉起窗口立即就位，内容加载完成后只是精修（秒开观感）
    if (this._wrapWindow) {
      this._refreshShellMetrics();
      if (this._originUnset() && this._screenW > 0) {
        this._originCssX = this._screenW * 0.9;
        this._originCssY = this._screenH * 0.45;
      }
      this._applyWindowSettingsAndroid(this._settings, true);
      this._syncWrapWindow();
    }

    // 不在 resize 事件里改画布尺寸：设置 canvas.width 会清空缓冲，
    // 若下一帧渲染前被合成器取样就是闪帧。改为渲染帧内同步（见 _frame）。
    this._resizeCanvas();

    // Tauri 环境探测（浏览器 dev 下静默降级）
    import('@tauri-apps/api/window')
      .then((m) => {
        this._tauriWindow = m.getCurrentWindow();
        // 启动即暖窗口位置缓存：否则首次拖动的前几帧会把窗口拉向 (0,0)
        this._syncWindowMetrics();
        this._tauriWindow.onMoved(() => {
          if (!this._dragging && !this._windowMoveTask) this._syncWindowMetrics();
        }).catch(() => {});
        this._tauriWindow.onScaleChanged(({ payload }) => {
          this._scaleFactor = payload.scaleFactor;
          this._syncWindowMetrics();
        }).catch(() => {});
      })
      .catch(() => {
        this._tauriWindow = null;
      });

    // 鼠标穿透命中表（Windows 壳）：低频把渲染 alpha 缩成占用掩码发给 Rust 命中线程
    if (platform === 'tauri') {
      import('@tauri-apps/api/core')
        .then((m) => {
          this._hitMaskSend = (args) => {
            m.invoke('update_hit_mask', args).catch(() => {});
          };
        })
        .catch(() => {
          this._hitMaskSend = null;
        });
    }

    CubismFramework.startUp();
    CubismFramework.initialize();
    return true;
  }

  public async loadModel(model3JsonUrl: string): Promise<void> {
    this._shellActionsReady = false;
    // 先尝试安装监听；IPC 故障不应阻断本地模型和互动。
    try {
      await this._wireSettingsSync();
      this._shellSyncNotice?.remove();
      this._shellSyncNotice = null;
    } catch (error) {
      console.error('[pet] shell event registration failed', error);
      this._shellSyncNotice = showStartupNotice('pet-shell-sync-error',
        '设置/托盘同步暂不可用，桌宠本地互动仍可使用。', error, async () => {
          await this._wireSettingsSync();
          this._shellSyncNotice = null;
        });
    }
    const response = await fetch(model3JsonUrl);
    const buffer = await response.arrayBuffer();
    const homeDir = model3JsonUrl.substring(
      0,
      model3JsonUrl.lastIndexOf('/') + 1
    );

    this._model = new PetModel();
    await this._model.loadFromSetting(buffer, buffer.byteLength, homeDir, {
      gl: this._gl,
      frameBuffer: this._frameBuffer,
      shaderPath: '/shaders/',
    });

    // 逻辑层装配
    await Promise.all([this._dialogue.loadAll(), this._hitAreas.load()]);
    const stage = document.getElementById('stage');
    this._bubble = new DialogueBubble(stage);
    this._interaction = new InteractionService({
      hitAreas: this._hitAreas,
      getTarget: () => (this._model?.isReady() ? this._model : null),
      dialogue: this._dialogue,
      pettingHost: {
        isDialogueActive: () => this._bubble?.isActive ?? false,
        playPettingDialogue: (resolved) => {
          this._speak(resolved, 'interaction');
        },
      },
      playCharacterAction: (action) => this._model?.playAction(action) ?? false,
    });
    this._interaction.playClickDialogue = (tag) => this._playInteraction(tag);
    this._interaction.isDialogueActive = () => this._bubble?.isActive ?? false;

    this._behavior = new BehaviorService(() =>
      this._model?.isReady() ? this._model : null
    );
    this._behavior.canIdle = () => this._coordination.canIdle();
    this._behavior.onRandomSpeech = () => this._playRandom();
    this._behavior.setActionMeta(this._model.actionManifest);
    this._behavior.start();

    // 情绪引擎（心境 → 默认表情 + 动作选择加权）+ AI 对外 API
    this._moodEngine = new MoodEngine(this._model);
    this._moodEngine.onMoodChanged((mood) => {
      this._behavior?.setMood(mood.name);
      this._broadcastMood(mood.name);
    });
    this._ai = new PetAI({
      model: () => (this._model?.isReady() ? this._model : null),
      moodEngine: () => this._moodEngine,
      playAction: (name) => {
        const ok = this._model?.playAction(name) ?? false;
        if (ok) this._behavior?.notifyManualAction();
        return ok;
      },
    });
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).petAI = this._ai;
      (window as unknown as Record<string, unknown>).__mood = this._moodEngine;
    }

    this._initializeChat();
    this._wirePointerEvents();
    this._startLoop();
    console.log('[pet] model + logic layer ready');

    // 悬浮窗首次启动（未保存过位置）：默认停在屏幕右下习惯位
    if (this._wrapWindow) {
      this._refreshShellMetrics();
      console.log(
        `[pet] wrap metrics: inner=${window.innerWidth}x${window.innerHeight} ` +
          `dpr=${window.devicePixelRatio} screen=${this._screenW}x${this._screenH}`
      );
      if (this._originUnset()) {
        this._originCssX = this._screenW * 0.9;
        this._originCssY = this._screenH * 0.45;
      }
    }

    // 启动时全量应用设置（含窗口位置/缩放/置顶恢复）
    this.applySettings(this._settings, true);
    this._flushPendingShellActions();
  }

  // ---------- 设置 ----------

  public get settings(): PetSettings {
    return this._settings;
  }

  /**
   * 设备允许的缩放范围：尺寸不超过当前显示器逻辑工作区，避免大到无法操作；
   * 这是尺寸上限，不是位置钳制，窗口位置仍可在工作区之外。
   */
  private _scaleLimitsFrom(
    mon: import('@tauri-apps/api/window').Monitor | null,
    baseW: number,
    baseH: number
  ): { minS: number; maxS: number } | null {
    if (!mon) return null;
    const logW = mon.workArea.size.width / mon.scaleFactor;
    const logH = mon.workArea.size.height / mon.scaleFactor;
    return {
      minS: Math.max(56 / baseW, 72 / baseH),
      maxS: Math.min(logW / baseW, logH / baseH),
    };
  }

  /** The overlay only runs local interactions; all network conversation lives in the main page. */
  private _initializeChat(): void {
    if (this._wrapWindow) return;
    let storage: ChatStorage | undefined;
    try { storage = window.localStorage; } catch { /* 存储被禁用时使用内存。 */ }
    this._chat = new ChatController({ label: '未连接', async *reply(): AsyncGenerator<never> { throw new Error('请先连接 Misskey。'); } });
    this._chatPerformance = new ChatPerformance({
      expressions: () => this._ai?.expressions() ?? [],
      actions: () => this._ai?.state().actions ?? [],
      expression: () => this._ai?.state().expression ?? null,
      express: name => { this._ai?.express(name); },
      clearExpression: () => this._ai?.clearExpression(),
      play: name => { this._ai?.play(name); },
      busy: () => this._paused || this._dragging || this._leftDown || (this._interaction?.isBusy ?? false),
    });
    if (platform === 'tauri') {
      const launcher = document.createElement('button');
      launcher.className = 'chat-launcher';
      launcher.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9.4L4 21.6V18H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>聊天</span>';
      launcher.setAttribute('aria-label', '和 Aliya 聊天');
      launcher.setAttribute('aria-pressed', 'false');
      document.body.append(launcher);
      this._chatLauncher = launcher;
      launcher.onclick = () => {
        // 开关式：再点一次收起输入框
        import('@tauri-apps/api/core')
          .then(m => m.invoke(this._remoteChat.open ? 'hide_chat' : 'show_chat'))
          .catch(() => {
            const label = launcher.querySelector('span');
            if (!label) return;
            label.textContent = '打开失败';
            setTimeout(() => { label.textContent = '聊天'; }, 1500);
          });
      };
      void import('@tauri-apps/api/event').then(async events => {
        await events.listen<typeof this._remoteChat>('chat-state', e => {
          this._remoteChat = e.payload; if (e.payload.open) this._bubble?.cancel();
          // 聊天窗口关闭即结束本轮表演，表情回情绪默认（持久表情不跨会话保留）
          if (!e.payload.open) this._chatPerformance?.cancel();
          if (this._chatLauncher) {
            this._chatLauncher.classList.toggle('open', e.payload.open);
            this._chatLauncher.setAttribute('aria-pressed', String(e.payload.open));
            // chat 已打开时从模型脚下移除入口，避免窗口与按钮隔出一层「外挂」感。
            this._chatLauncher.hidden = e.payload.open;
          }
          // 记忆开关状态（chat-state 由壳按窗口可见性广播），下次启动据此恢复。
          try { storage?.setItem('aliya_chat_open', e.payload.open ? '1' : '0'); } catch { /* 存储不可用则跳过 */ }
        });
        await events.listen<import('./chat/types').PerformanceCue>('chat-cue', e => {
          if (!this._paused) this._chatPerformance?.cue(e.payload);
        });
        await events.listen('chat-cancel', () => this._chatPerformance?.cancel());
      });
      // 上次退出时聊天窗开着则直接恢复；定位在 pet Moved 事件中自校正。
      try {
        if (storage?.getItem('aliya_chat_open') === '1') {
          void import('@tauri-apps/api/core').then(m => m.invoke('show_chat')).catch(() => {});
        }
      } catch { /* 存储不可用则每次手动打开 */ }
      return;
    }
    this._chatView = new ChatView(this._chat, new MskAuth(storage), open => {
      this._bubble?.cancel();
      this._cancelInteraction();
      this._resetDragState();
      this._hitMaskLastMs = -Infinity;
      if (!open) this._chatPerformance?.cancel();
    }, storage);
    this._chat.onCue = cue => {
      if (this._chatView?.isOpen && !this._paused) this._chatPerformance?.cue(cue);
    };
    this._chat.onCancelPerformance = () => this._chatPerformance?.cancel();
    const mobile = platform === 'android' || (platform === 'web' && matchMedia('(max-width: 560px)').matches);
    document.body.classList.toggle('chat-mobile', mobile);
    if (platform === 'android') this._chatView.setOpen(true);
  }

  public handleBack(): boolean {
    return this._chatView?.handleBack() ?? false;
  }

  /** 当前窗口基准尺寸（模型加载后用实测包围盒，否则用默认比例）。 */
  private _baseWindowSize(): { baseW: number; baseH: number } {
    const baseH = 675 * PetApp._windowMarginRatio;
    const baseW =
      baseH *
      (this._model?.isReady() ? this._model.boundsAspect : 512 / 768);
    return { baseW, baseH };
  }

  /**
   * 异步查询设备缩放范围（托盘「切换尺寸」用）。
   * 查不到显示器时回退到与设置页一致的默认范围 [0.15, 2.0]。
   */
  private async _deviceScaleRange(): Promise<{ minS: number; maxS: number }> {
    try {
      const m = await import('@tauri-apps/api/window');
      let mon: import('@tauri-apps/api/window').Monitor | null = null;
      try {
        mon = (await m.currentMonitor()) ?? (await m.primaryMonitor());
      } catch {
        mon = null;
      }
      const { baseW, baseH } = this._baseWindowSize();
      return (
        this._scaleLimitsFrom(mon, baseW, baseH) ?? { minS: 0.15, maxS: 2.0 }
      );
    } catch {
      return { minS: 0.15, maxS: 2.0 };
    }
  }

  /** 托盘「切换尺寸」：在设备范围内按最小→中点→最大等步长循环。 */
  private async _cycleSize(): Promise<void> {
    const { minS, maxS } = await this._deviceScaleRange();
    const next = nextSizePreset(this._settings.scale, minS, maxS);
    this.applySettings({ ...this._settings, scale: next }, false);
    this._broadcastSettings();
  }

  /**
   * 应用设置。restoreWindow=true 时恢复保存的窗口位置（仅启动）。
   * 窗口操作需要 Tauri 环境，浏览器 dev 下静默跳过。
   */
  public applySettings(s: PetSettings, restoreWindow = false): void {
    this._cancelSnapAnimation();
    // 设置页可能携带过期坐标；非启动请求只改变设置，不覆盖最近已确认的位置。
    if (!restoreWindow && this._settings) s = { ...s, posX: this._settings.posX, posY: this._settings.posY };
    this._settings = s;
    const positionRevision = this._windowPositionRevision ?? 0;
    const revision = ++this._windowSettingsRevision;
    const restoredPosition = restoreWindow && s.posX != null && s.posY != null
      ? { x: s.posX, y: s.posY } : null;
    saveSettings(s);

    // 行为层
    if (this._behavior) {
      this._behavior.autoActions = s.autoActions;
      this._behavior.randomSpeechEnabled = s.randomSpeech;
      this._behavior.randomSpeechIntervalMinutes = s.randomSpeechMinutes;
      this._behavior.mirrorX = s.mirror;
      this._behavior.refreshRandomSpeech();
    }
    // 省电模式：15fps（相对 URL/默认帧率下调，设置页切换实时生效）
    this.setFpsCap(s.batterySaver ? 15 : this._baseFpsCap);
    this._hitAreas.mirrored = s.mirror;
    this.setMirrored(s.mirror);

    // 窗口层
    if (platform === 'android') {
      if (!this._wrapWindow) {
        this._chatBackground ??= new ChatBackgroundLayer();
        const key = `${s.chatBackground}:${s.chatBackgroundRev ?? 0}:${s.chatBackgroundDim}`;
        if (key !== this._chatBackgroundKey) {
          this._chatBackgroundKey = key;
          void this._chatBackground.apply(s.chatBackground, s.chatBackgroundDim);
        }
      }
      this._applyWindowSettingsAndroid(s, restoreWindow);
      return;
    }
    const win = this._tauriWindow;
    if (win) {
      win.setAlwaysOnTop(s.alwaysOnTop).catch(() => {});
      if (this._canAnimateScale(restoredPosition)) {
        const anim = this._scaleAnim ??= { target: s.scale, running: false };
        anim.target = s.scale;
        if (!anim.running) this._startScaleAnimation(anim);
        return;
      }
      this._queueWindowGeometry(() => this._applyDesktopGeometry(s, revision, positionRevision, restoredPosition),
        'Failed to apply pet window settings');
    }
  }

  /** Windows 外窗几何一步落定（启动恢复、少动态效果、无法逐帧补间时）。 */
  private async _applyDesktopGeometry(s: PetSettings, revision: number, positionRevision: number,
    restoredPosition: { x: number; y: number } | null): Promise<void> {
    const win = this._tauriWindow;
    if (!win) return;
    if (revision !== this._windowSettingsRevision) return;
    const m = await import('@tauri-apps/api/window');
    // 尺寸上限由显示器逻辑工作区推导；只限制尺寸，不限制窗口位置。
    let mon: import('@tauri-apps/api/window').Monitor | null = null;
    try {
      mon = (await m.currentMonitor()) ?? (await m.primaryMonitor());
    } catch {
      mon = null;
    }
    // 窗口基准尺寸与 native ComputeTargetPixelSize 一致：
    //   高 = 675 × 1.18，宽 = 高 × 包围盒宽高比（模型加载完成后才有真实值）
    const { baseW, baseH } = this._baseWindowSize();
    let scale = s.scale;
    const limits = this._scaleLimitsFrom(mon, baseW, baseH);
    if (limits) {
      scale = Math.min(Math.max(scale, limits.minS), limits.maxS);
    }
    if (revision !== this._windowSettingsRevision) return;
    const chatOpen = this._chatView?.isOpen ?? false;
    const roomW = mon ? mon.workArea.size.width / mon.scaleFactor : 1000;
    const roomH = mon ? mon.workArea.size.height / mon.scaleFactor : 900;
    const width = chatOpen ? Math.min(roomW, Math.max(680, baseW * scale)) : baseW * scale;
    const height = chatOpen ? Math.min(roomH, Math.max(560, Math.min(760, baseH * scale))) : baseH * scale;
    document.body.classList.toggle('chat-mobile', chatOpen && width < 580);
    // 用实际客户区的物理尺寸计算脚底，不能把窗口底边当作角色脚底。
    const beforePos = await win.outerPosition();
    const beforeSize = await win.innerSize();
    if (revision !== this._windowSettingsRevision) return;
    // 前后补偿使用同一变换状态，不能混入等待期间新请求的镜像或布局。
    const mirror = s.mirror;
    const beforeFoot = this._windowFootOffset(beforeSize, mirror, chatOpen);
    const anchor = {
      x: beforePos.x + beforeFoot.x + this._windowResizeRemainder.x,
      y: beforePos.y + beforeFoot.y + this._windowResizeRemainder.y,
    };
    // 在调用前登记补偿：Promise 拒绝不代表原生尺寸没有改变。
    this._windowResizeRecovery = async (publish = true) => {
      const afterSize = await win.innerSize();
      const sf = await win.scaleFactor();
      const afterFoot = this._windowFootOffset(afterSize, mirror, chatOpen);
      const target = restoredPosition ?? {
        x: Math.round(anchor.x - afterFoot.x), y: Math.round(anchor.y - afterFoot.y),
      };
      const current = await win.outerPosition();
      if (current.x !== target.x || current.y !== target.y) {
        await this._setWindowPositionVerified(new m.PhysicalPosition(target.x, target.y));
      }
      this._windowResizeRemainder = restoredPosition ? { x: 0, y: 0 } : {
        x: anchor.x - target.x - afterFoot.x, y: anchor.y - target.y - afterFoot.y,
      };
      this._rebaseWindowPosition(target, beforePos, positionRevision);
      this._scaleFactor = sf; this._metricsSynced = true;
      this._windowResizeRecovery = null;
      this._windowGeometryError = null;
      if (publish && positionRevision === (this._windowPositionRevision ?? 0) && !this._dragging &&
          revision === this._windowSettingsRevision) this._persistDesktopPos();
      if (publish) this._syncChatAnchor({ cssW: afterSize.width / sf, cssH: afterSize.height / sf });
    };
    // 预测缩放后的物理尺寸，位置与尺寸同一次原生调用落定（脚底不先跳再拉回）；
    // 系统若钳制了尺寸，下面的补偿按实测尺寸再校正一次位置。
    const sf = await win.scaleFactor();
    const predicted = { width: Math.max(1, Math.round(width * sf)), height: Math.max(1, Math.round(height * sf)) };
    const predictedFoot = this._windowFootOffset(predicted, mirror, chatOpen);
    const target = restoredPosition ?? {
      x: Math.round(anchor.x - predictedFoot.x), y: Math.round(anchor.y - predictedFoot.y),
    };
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_pet_bounds', { x: target.x, y: target.y, w: predicted.width, h: predicted.height });
    } catch (error) { await this._windowResizeRecovery(); throw error; }
    await this._windowResizeRecovery();
  }

  private _animationsAllowed(): boolean {
    return platform === 'tauri' && !!this._canvas?.parentElement && typeof window.matchMedia === 'function'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private _canAnimateScale(restoredPosition: { x: number; y: number } | null): boolean {
    return !restoredPosition && !this._chatView && this._metricsSynced && !!this._model?.isReady() && this._animationsAllowed();
  }

  private _startScaleAnimation(anim: { target: number; running: boolean }): void {
    anim.running = true;
    void this._queueWindowGeometry(() => this._runScaleAnimation(anim), 'Failed to animate pet scale')
      .finally(() => {
        // 循环收尾与新目标到达之间的竞态：目标在收尾后又变了就接着补间。
        if (!anim.running && Math.abs(anim.target - this._scaleAnimDone) > 1e-9 && this._canAnimateScale(null)) this._startScaleAnimation(anim);
      });
  }

  /**
   * Windows 缩放补间：外窗逐帧按同一比例缩放（宽高比不变、脚底固定），角色始终按窗口自然适配。
   * WebView2 在原生 resize 后会把上一帧整体拉伸到新窗口显示一两帧；外窗与角色严格同比时，
   * 这一帧拉伸恰好就是下一帧该有的样子，因此连续拖动滑杆也不闪、不抽。
   * 画内补间 + 外窗分步落定会让拉伸帧与真实比例不一致（角色先跳大/跳位再归位），不能用。
   */
  private async _runScaleAnimation(anim: { target: number; running: boolean }): Promise<void> {
    const win = this._tauriWindow;
    try {
      if (!win) return;
      const m = await import('@tauri-apps/api/window');
      let mon: import('@tauri-apps/api/window').Monitor | null = null;
      try { mon = (await m.currentMonitor()) ?? (await m.primaryMonitor()); } catch { mon = null; }
      const { baseW, baseH } = this._baseWindowSize();
      const limits = this._scaleLimitsFrom(mon, baseW, baseH);
      const clamp = (v: number) => limits ? Math.min(Math.max(v, limits.minS), limits.maxS) : v;
      const [pos, size, sf] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
      const mirror = this._settings.mirror;
      const foot0 = this._windowFootOffset(size, mirror, false);
      const anchor = { x: pos.x + foot0.x + this._windowResizeRemainder.x, y: pos.y + foot0.y + this._windowResizeRemainder.y };
      const positionRevision = this._windowPositionRevision ?? 0;
      this._scaleTween = null;
      let current = size.height / sf / baseH;
      let geo = { x: pos.x, y: pos.y, w: size.width, h: size.height };
      let last = performance.now();
      const { invoke } = await import('@tauri-apps/api/core');
      for (;;) {
        const target = clamp(anim.target);
        if (Math.abs(current / target - 1) < 0.002) current = target;
        else {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const now = performance.now();
          const dt = Math.min(64, Math.max(1, now - last));
          last = now;
          current += (target - current) * (1 - Math.exp(-dt / PetApp._scaleEaseMs));
          if (Math.abs(current / target - 1) < 0.002) current = target;
        }
        const w = Math.max(1, Math.round(baseW * current * sf));
        const h = Math.max(1, Math.round(baseH * current * sf));
        const foot = this._windowFootOffset({ width: w, height: h }, mirror, false);
        const next = { x: Math.round(anchor.x - foot.x), y: Math.round(anchor.y - foot.y), w, h };
        if (next.x !== geo.x || next.y !== geo.y || next.w !== geo.w || next.h !== geo.h) {
          await invoke('set_pet_bounds', next);
          geo = next;
          this._winPhysX = next.x; this._winPhysY = next.y;
        }
        if (current === target && target === clamp(anim.target)) break;
      }
      const foot = this._windowFootOffset({ width: geo.w, height: geo.h }, mirror, false);
      this._windowResizeRemainder = { x: anchor.x - geo.x - foot.x, y: anchor.y - geo.y - foot.y };
      this._scaleFactor = sf; this._metricsSynced = true;
      this._scaleAnimDone = anim.target;
      if (positionRevision === (this._windowPositionRevision ?? 0) && !this._dragging) this._persistDesktopPos();
      this._syncChatAnchor({ cssW: geo.w / sf, cssH: geo.h / sf });
    } finally {
      anim.running = false;
    }
  }

  /** chat 卡片宽 = pet 窗口宽 × 1.18（逐帧上报，壳侧钳制并换算整卡缩放）。 */
  private _reportChatLayout(): void {
    if (platform !== 'tauri' || !this._metricsSynced || !this._model?.isReady()) return;
    const stageW = this._canvas.parentElement?.getBoundingClientRect().width ?? 0;
    if (!(stageW > 0)) return;
    const width = Math.round(stageW * 1.18);
    if (width === this._chatLayoutWidth) return;
    this._chatLayoutWidth = width;
    void import('@tauri-apps/api/core').then(m => m.invoke('set_chat_layout', { width })).catch(() => {});
  }

  /** 所有应用侧原生几何写入共用队列；已开始的副作用不能用 revision 丢弃。 */
  private _queueWindowGeometry(operation: () => Promise<void>, label: string): Promise<void> {
    this._windowGeometryPending = (this._windowGeometryPending ?? 0) + 1;
    this._windowGeometryRevision = (this._windowGeometryRevision ?? 0) + 1;
    const task = (this._windowSettingsTask ?? Promise.resolve()).then(async () => {
      if (this._windowResizeRecovery) await this._windowResizeRecovery(false);
      await operation();
    }).catch(error => { this._windowGeometryError = error; console.warn(label, error); }).finally(() => { this._windowGeometryPending--; });
    this._windowSettingsTask = task;
    return task;
  }

  /** IPC 拒绝不能证明 Win32 副作用未发生；所有位置写入用读回确认统一处理。 */
  private async _setWindowPositionVerified(position: import('@tauri-apps/api/window').PhysicalPosition): Promise<void> {
    const win = this._tauriWindow;
    if (!win) throw new Error('Pet window unavailable');
    try { await win.setPosition(position); }
    catch (error) {
      const actual = await win.outerPosition();
      if (actual.x !== position.x || actual.y !== position.y) throw error;
      console.warn('Pet position IPC failed after native position was applied', error);
    }
    this._windowGeometryError = null;
  }

  /** 缩放/重置改变原点时，后到的拖动仍表示相同屏幕位移，不能退回旧原点。 */
  private _rebaseWindowPosition(target: { x: number; y: number }, before: { x: number; y: number }, revision: number): void {
    if (revision === (this._windowPositionRevision ?? 0)) {
      this._winPhysX = target.x; this._winPhysY = target.y;
    } else if (this._windowPositionKind === 'move') {
      this._winPhysX += target.x - before.x; this._winPhysY += target.y - before.y;
    }
  }

  /** 与 _render 相同的适配公式；输入、输出均为物理像素。 */
  private _windowFootOffset(
    size: { width: number; height: number }, mirror: boolean, chatOpen: boolean
  ): { x: number; y: number } {
    const ready = this._model?.isReady();
    const bounds = ready ? this._model.getStaticBounds() : null;
    const fitH = chatOpen && ready
      ? Math.min(size.height, size.width / this._model.boundsAspect) : size.height;
    const scale = fitH / PetApp._renderMarginRatio / (ready ? this._model.boundsH : 1);
    return {
      x: size.width / 2 + (bounds ? (bounds.minX + bounds.maxX) / 2 : 0) * scale * (mirror ? -1 : 1),
      y: size.height / 2 - (bounds?.minY ?? -0.5) * scale,
    };
  }

  /** 刷新壳侧屏幕尺寸缓存（CSS px；缩放和贴边共用）。 */
  private _refreshShellMetrics(): void {
    const shell = androidShell();
    if (!shell) return;
    try {
      const m = JSON.parse(shell.getMetrics()) as {
        screenW: number;
        screenH: number;
      };
      if (m.screenW > 0 && m.screenH > 0) {
        this._screenW = m.screenW;
        this._screenH = m.screenH;
      }
    } catch {
      // 保持缓存
    }
  }

  /**
   * Android：App 内为全屏容器无窗口操作；悬浮窗走内容贴合模式，
   * 这里只钳制缩放范围（CSS px），窗口矩形由渲染帧逐帧跟随角色剪影。
   */
  private _applyWindowSettingsAndroid(s: PetSettings, restoreWindow: boolean): void {
    const shell = androidShell();
    if (!shell) return;
    this._refreshShellMetrics();
    const baseH = 675 * PetApp._windowMarginRatio;
    const baseW =
      baseH * (this._model?.isReady() ? this._model.boundsAspect : 512 / 768);
    let scale = s.scale;
    if (this._screenW > 0 && this._screenH > 0) {
      const minS = Math.max(56 / baseW, 72 / baseH);
      const maxS = Math.max(minS, Math.min(this._screenW / baseW, (this._screenH - PetApp._WRAP_BUBBLE_BAND) / baseH));
      scale = Math.min(Math.max(scale, minS), maxS);
    }
    if (this._wrapWindow) {
      // 原点补偿以上次落定的比例为准（原点只对它成立）；补间起点取当前显示比例（中途再改不跳）。
      const previousScale = this._contentScaleCss;
      const shownScale = this._scaleTweenValue() ?? previousScale;
      if (s.scale !== scale) {
        this._settings.scale = scale;
        saveSettings(this._settings);
      }
      // 贴合模式：尺寸直接驱动内容渲染比例，画布在帧循环内跟随窗口
      this._contentScaleCss =
        (baseH * scale) / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
      if (restoreWindow && !this._originUnset()) {
        this._originCssX = s.posX as number;
        this._originCssY = s.posY as number;
      }
      if (!restoreWindow && this._rectInited) {
        const bounds = this._model?.getStaticBounds();
        // 脚底（静态包围盒底边中点）屏幕位置不变：x 也要补，否则补间结束会横跳 cx·Δs。
        if (bounds) {
          const delta = this._contentScaleCss - previousScale;
          this._originCssX -= ((bounds.minX + bounds.maxX) / 2) * delta;
          this._originCssY += bounds.minY * delta;
        }
        this._persistWrapOrigin();
        // 画内从当前显示比例补间到新比例（以脚底为锚）；外窗按两端较大者一次给足，
        // 缩小时播完再收窗（见 _fixedWindowRect），全程只重配两次窗口表面。
        if (shownScale > 0 && Math.abs(this._contentScaleCss / shownScale - 1) > 0.005
          && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          this._scaleTween = { from: shownScale, to: this._contentScaleCss, start: performance.now(), settled: true };
        } else this._scaleTween = null;
      }
      this._rectInited = false;
      if (this._model?.isReady() && s.snapEdges) this._onDragFinishedAndroid();
      return;
    }
    // App 内全屏：无窗口操作（保留签名兼容旧逻辑）
    void restoreWindow;
  }

  /**
   * 贴合模式原点是否未设置。
   * App 内全屏模式的拖动结束曾把 (0,0) 当窗口坐标写入 posX/posY，
   * 而合法原点（角色锚点）不可能是 (0,0)——视为未设置，走默认位。
   */
  private _originUnset(): boolean {
    const { posX, posY } = this._settings;
    return posX == null || posY == null || (posX === 0 && posY === 0);
  }

  /** 镜像显示：画布 CSS 翻转（合成层零成本）+ 命中区域/视线同步翻转。 */
  public setMirrored(v: boolean): void {
    this._canvas.style.transform = v ? 'scaleX(-1)' : '';
  }

  /** 设置窗口/托盘事件接线；模型重载时复用注册任务，避免重复监听。 */
  private _wireSettingsSync(): Promise<void> {
    if (platform !== 'tauri') return Promise.resolve();
    return this._settingsSyncTask ??= import('@tauri-apps/api/event').then(async (ev) => {
      const installed = this._settingsSyncListeners ??= new Set<string>();
      const listen = async <T>(name: string, handler: import('@tauri-apps/api/event').EventCallback<T>) => {
        if (installed.has(name)) return;
        try {
          await ev.listen<T>(name, handler);
          installed.add(name);
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`);
        }
      };
      // 等待全部结果，保留已成功的监听；重试只补装失败项。
      const results = await Promise.allSettled([
        listen<PetSettings>('settings-changed', (e) => {
          if (!e.payload || typeof e.payload !== 'object') return;
          this.applySettings(e.payload, false);
        }),
        listen<ShellAction>('tray-action', (e) => {
          const p = e.payload;
          if (!p || typeof p.action !== 'string') return;
          this.onShellAction(p);
        }),
        // Rust 全局光标广播（物理 px）：光标不在窗口上时视线也要跟随
        listen<{ x: number; y: number }>('global-mouse', (e) => {
          if (!this._behavior || this._wrapWindow) return;
          if (Number.isFinite(e.payload.x) && Number.isFinite(e.payload.y)) {
            this._globalMouse = e.payload;
          }
        }),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }).catch(error => {
      this._settingsSyncTask = null;
      throw error;
    });
  }

  /** 向设置窗口广播当前设置（托盘改动后保持 UI 同步）。 */
  private _broadcastSettings(): void {
    const win = this._tauriWindow;
    if (!win) return;
    import('@tauri-apps/api/event')
      .then((ev) => {
        ev.emitTo('settings', 'settings-changed', this._settings).catch(() => {});
      })
      .catch(() => {});
  }

  /**
   * 壳动作入口（tray-action 形状）：Windows 托盘/设置窗口经 Tauri 事件，
   * Android 设置页经壳桥 notifyPetAction 转发（main.ts 暴露给
   * window.__pet.onShellAction）。
   */
  public onShellAction(p: ShellAction): void {
    if (!this._shellActionsReady && [
      'open-chat', 'play-action', 'random-speech', 'express', 'clear-expression', 'set-mood',
    ].includes(p.action)) {
      // 启动阶段连续点随机台词只补发一次，不积压一串气泡。
      if (p.action !== 'random-speech' || !this._pendingShellActions.some(a => a.action === p.action)) {
        this._pendingShellActions.push({ ...p });
      }
      return;
    }
    switch (p.action) {
        case 'open-chat':
          if (this._chatView && !this._chatView.isOpen) this._chatView.setOpen(true);
          break;
        case 'cycle-size': {
          void this._cycleSize();
          break;
        }
        case 'always-on-top':
          // Rust 已应用到窗口，这里只同步存储与其他开关
          this.applySettings(
            { ...this._settings, alwaysOnTop: p.value ?? true },
            false
          );
          this._broadcastSettings();
          break;
        case 'reset-position':
          this.resetPosition();
          break;
        case 'play-action':
          if (p.name) this._ai?.play(p.name);
          break;
        case 'random-speech':
          this._playRandom('manual');
          break;
        // 表情/情绪（设置窗口「表情与情绪」面板）
        case 'express':
          if (p.name) this._ai?.express(p.name, p.duration);
          break;
        case 'clear-expression':
          this._ai?.clearExpression();
          break;
        case 'set-mood':
          if (p.name) this._ai?.setMood(p.name, p.duration);
          break;
    }
  }

  /** 模型、台词和气泡就绪后补发；忙碌/暂停等仲裁仍由正常入口处理。 */
  private _flushPendingShellActions(): void {
    this._shellActionsReady = true;
    const pending = this._pendingShellActions.splice(0);
    for (const action of pending) this.onShellAction(action);
  }

  /** 向设置窗口广播当前情绪（「表情与情绪」面板高亮同步）。 */
  private _broadcastMood(name: string): void {
    // Android：设置页是另一 WebView，经共享 localStorage 传递（focus/回前台读取）
    if (platform === 'android') {
      try { window.localStorage.setItem('aliya_pet_mood', name); } catch { /* 存储不可用则跳过 */ }
    }
    if (!this._tauriWindow) return;
    import('@tauri-apps/api/event')
      .then((ev) => {
        ev.emitTo('settings', 'pet-mood', { mood: name }).catch(() => {});
      })
      .catch(() => {});
  }

  /** 位置重置：移回主屏幕中央。 */
  public resetPosition(): void {
    this._cancelSnapAnimation();
    if (platform === 'android') {
      const shell = androidShell();
      if (!shell) return;
      this._refreshShellMetrics();
      const m = JSON.parse(shell.getMetrics()) as {
        screenW: number;
        screenH: number;
        winW: number;
        winH: number;
      };
      if (this._wrapWindow) {
        // 贴合模式：原点居中即可，窗口矩形下帧自动跟随
        const x = m.screenW / 2;
        const y = m.screenH * 0.45;
        this._originCssX = x;
        this._originCssY = y;
        this._rectDirty = true;
        this._settings.posX = x;
        this._settings.posY = y;
        saveSettings(this._settings);
        shell.setPref('petX', String(Math.round(x)));
        shell.setPref('petY', String(Math.round(y)));
        return;
      }
      const x = Math.round(m.screenW / 2);
      const y = Math.round(m.screenH * 0.45);
      this._settings.posX = x;
      this._settings.posY = y;
      saveSettings(this._settings);
      shell.setPref('petX', String(x));
      shell.setPref('petY', String(y));
      return;
    }
    const win = this._tauriWindow;
    if (!win) return;
    const revision = this._windowPositionRevision = (this._windowPositionRevision ?? 0) + 1;
    this._windowPositionKind = 'reset';
    this._queueWindowGeometry(async () => {
      const m = await import('@tauri-apps/api/window');
      if (revision !== this._windowPositionRevision) return;
      const mon = (await m.currentMonitor()) ?? (await m.primaryMonitor());
      if (!mon || revision !== this._windowPositionRevision) return;
      const size = await win.outerSize();
      const before = await win.outerPosition();
      if (revision !== this._windowPositionRevision) return;
      const target = {
        x: mon.workArea.position.x + Math.round((mon.workArea.size.width - size.width) / 2),
        y: mon.workArea.position.y + Math.round((mon.workArea.size.height - size.height) / 2),
      };
      await this._setWindowPositionVerified(new m.PhysicalPosition(target.x, target.y));
      this._windowResizeRemainder = { x: 0, y: 0 };
      this._rebaseWindowPosition(target, before, revision);
      if (revision === this._windowPositionRevision) this._persistDesktopPos();
      this._syncChatAnchor();
    }, 'Failed to reset pet position');
  }

  /** 短暂显示贴边成功反馈，不额外扩大可点击区域。 */
  private _showSnapHint(edges: string[]): void {
    if (!edges.length) return;
    document.body.dataset.snapEdge = edges.join(' ');
    document.body.classList.remove('snap-confirm');
    void document.body.offsetWidth;
    document.body.classList.add('snap-confirm');
    if (this._snapHintTimer) clearTimeout(this._snapHintTimer);
    this._snapHintTimer = setTimeout(() => {
      document.body.classList.remove('snap-confirm');
      delete document.body.dataset.snapEdge;
      this._snapHintTimer = null;
    }, 650);
  }

  private static _snapAxis(
    pos: number, min: number, max: number, zone: number,
  ): { v: number; edge: 'min' | 'max' | null } {
    max = Math.max(min, max);
    const nearMin = pos <= min + zone;
    const nearMax = pos >= max - zone;
    if (nearMin && (!nearMax || Math.abs(pos - min) <= Math.abs(pos - max))) {
      return { v: min, edge: 'min' };
    }
    if (nearMax) return { v: max, edge: 'max' };
    return { v: pos, edge: null };
  }

  /** 松手后才贴边；Windows 由系统选择所在显示器，完全出屏时选择最近显示器。 */
  private _onDragFinished(): void {
    if (platform === 'android') {
      this._onDragFinishedAndroid();
      return;
    }
    const win = this._tauriWindow;
    if (!win) return;
    this._cancelSnapAnimation();
    const token = this._snapAnimToken;
    const pendingMove = this._windowMoveTask;
    import('@tauri-apps/api/window')
      .then(async (m) => {
        await pendingMove;
        await this._windowSettingsTask;
        const geometryRevision = this._windowGeometryRevision ?? 0;
        const current = () => token === this._snapAnimToken &&
          geometryRevision === (this._windowGeometryRevision ?? 0) && !this._windowGeometryPending &&
          !this._windowResizeRecovery && !this._windowGeometryError;
        if (!current()) return;
        const pos = await win.outerPosition();
        if (!current()) return;
        this._winPhysX = pos.x;
        this._winPhysY = pos.y;
        if (this._settings.snapEdges) {
          const [mon, size] = await Promise.all([m.currentMonitor(), win.outerSize()]);
          if (!current()) return;
          if (mon) {
            const zone = Math.round(PetApp._snapZonePx * mon.scaleFactor);
            const left = mon.workArea.position.x;
            const top = mon.workArea.position.y;
            const right = left + mon.workArea.size.width - size.width;
            const bottom = top + mon.workArea.size.height - size.height;
            const sx = PetApp._snapAxis(pos.x, left, right, zone);
            const sy = PetApp._snapAxis(pos.y, top, bottom, zone);
            const edges: string[] = [];
            if (sx.edge) edges.push(sx.edge === 'min' ? 'left' : 'right');
            if (sy.edge) edges.push(sy.edge === 'min' ? 'top' : 'bottom');
            if (sx.v !== pos.x || sy.v !== pos.y) {
              await this._animateWindowToPhys(sx.v, sy.v);
              if (token !== this._snapAnimToken) return;
            }
            this._showSnapHint(edges);
          }
        }
        if (token !== this._snapAnimToken || this._windowGeometryPending) return;
        this._persistDesktopPos();
      })
      .catch(error => { console.warn('Failed to finish pet drag', error); });
  }

  /** 持久化桌面窗口位置（物理 px）。 */
  private _persistDesktopPos(): void {
    if (this._dragging || this._windowResizeRecovery || this._windowGeometryError) return;
    this._settings.posX = this._winPhysX;
    this._settings.posY = this._winPhysY;
    saveSettings(this._settings);
  }

  private _cancelSnapAnimation(): void {
    this._snapAnimToken++;
    if (this._nativeSnapping) {
      // 原点已是终点：下一帧把窗口矩形下发到终点（壳收到 setWindowRect 即停掉原生动画）。
      this._nativeSnapping = false;
      this._rectInited = false;
    }
    this._snapAnimation?.cancel();
    this._snapAnimation = null;
    if (this._snapHintTimer) clearTimeout(this._snapHintTimer);
    this._snapHintTimer = null;
    document.body.classList.remove('snap-confirm');
    delete document.body.dataset.snapEdge;
  }

  /** 原生动画引擎负责时间线和缓动；窗口不是 DOM 元素，逐帧仅桥接位置。 */
  private async _animateSnap(
    update: (progress: number) => void | Promise<void>, durMs = 220,
  ): Promise<boolean> {
    const token = this._snapAnimToken;
    const style = getComputedStyle(document.documentElement);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await update(1);
      return token === this._snapAnimToken;
    }
    const effect = new KeyframeEffect(null, null, {
      duration: durMs,
      easing: style.getPropertyValue('--al-ease').trim(),
      fill: 'both',
    });
    const animation = new Animation(effect, document.timeline);
    this._snapAnimation = animation;
    animation.play();
    try {
      while (token === this._snapAnimToken) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (token !== this._snapAnimToken) return false;
        const progress = effect.getComputedTiming().progress ?? 0;
        // 等待这一帧实际提交，避免 IPC 积压把动画合并成一次瞬移。
        await update(progress);
        if (progress === 1) return token === this._snapAnimToken;
      }
      return false;
    } finally {
      animation.cancel();
      if (this._snapAnimation === animation) this._snapAnimation = null;
    }
  }

  private async _animateWindowToPhys(tx: number, ty: number): Promise<void> {
    const sx = this._winPhysX;
    const sy = this._winPhysY;
    const completed = await this._animateSnap(async progress => {
      this._winPhysX = Math.round(sx + (tx - sx) * progress);
      this._winPhysY = Math.round(sy + (ty - sy) * progress);
      await this._submitWindowPos();
    });
    if (completed) this._syncChatAnchor();
  }

  /**
   * Android 拖动结束：贴边吸附（缓动归位）+ 位置持久化。
   * 开启贴边时越界必归位（越界即近边的延伸）；关闭时可整个拖出屏幕
   * （找不回时走设置页「重置位置」）。
   */
  private _onDragFinishedAndroid(): void {
    const shell = androidShell();
    if (!shell) return;
    // App 内全屏模式没有可移动的窗口：不吸附、不持久化
    // （曾在此把 winX/winY(=0,0) 当窗口坐标写进 posX/posY，污染悬浮窗原点）
    if (!this._wrapWindow) return;
    if (this._settings.snapEdges) {
      this._refreshShellMetrics();
      const m = { screenW: this._screenW, screenH: this._screenH };
      const b = this._model?.getStaticBounds() ?? null;
      if (b && m.screenW > 0) {
        const s = this._contentScaleCss;
        const zone = PetApp._snapZonePx;
        let tx = this._originCssX;
        let ty = this._originCssY;
        const charL = tx + b.minX * s;
        const charR = tx + b.maxX * s;
        const charT = ty - b.maxY * s;
        const charB = ty - b.minY * s;
        // 统一规则：角色边越界或在感应带内 → 贴到对应屏边
        if (charL <= zone) tx -= charL;
        else if (charR >= m.screenW - zone) tx += m.screenW - charR;
        if (charT <= zone) ty -= charT;
        else if (charB >= m.screenH - zone) ty += m.screenH - charB;
        if (tx !== this._originCssX || ty !== this._originCssY) {
          this._animateOriginTo(tx, ty);
          return; // 动画末帧持久化
        }
      }
    }
    this._persistWrapOrigin();
  }

  /** 持久化悬浮窗原点（localStorage + 壳侧 SharedPreferences 双写）。 */
  private _persistWrapOrigin(): void {
    const shell = androidShell();
    this._settings.posX = this._originCssX;
    this._settings.posY = this._originCssY;
    saveSettings(this._settings);
    shell?.setPref('petX', String(Math.round(this._originCssX)));
    shell?.setPref('petY', String(Math.round(this._originCssY)));
  }

  private _animateOriginTo(tx: number, ty: number, durMs = 220): void {
    this._cancelSnapAnimation();
    const shell = androidShell();
    if (shell?.animateWindowTo && this._rectInited && !this._scaleTween
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // 原生动画按屏幕刷新率逐帧 updateViewLayout，不经 JS 帧循环（省电模式 15fps 下也平滑）。
      // 原点与已应用矩形同步改到终点：角色在窗口内相对静止，只有窗口平移。
      const dx = tx - this._originCssX, dy = ty - this._originCssY;
      this._originCssX = tx; this._originCssY = ty;
      this._appliedRectX = Math.round(this._appliedRectX + dx);
      this._appliedRectY = Math.round(this._appliedRectY + dy);
      this._nativeSnapping = true;
      shell.animateWindowTo(this._appliedRectX, this._appliedRectY, durMs);
      return;
    }
    const sx = this._originCssX;
    const sy = this._originCssY;
    void this._animateSnap(progress => {
      this._originCssX = sx + (tx - sx) * progress;
      this._originCssY = sy + (ty - sy) * progress;
      this._rectDirty = true;
    }, durMs).then(completed => {
      if (completed) this._persistWrapOrigin();
    }).catch(() => {});
  }

  // ---------- 台词 ----------

  private _speak(resolved: ResolvedDialogue, source: SpeechSource): void {
    if ((this._remoteChat.open || this._chatView?.isOpen) && source !== 'conversation') return;
    if (this._coordination.canSpeak(source)) void this._bubble?.play(resolved);
  }

  private _playInteraction(tag: string): void {
    if (this._remoteChat.open || this._chatView?.isOpen || !this._coordination.canSpeak('interaction')) return;
    const resolved = this._dialogue.resolveSceneTag('interaction', tag)
      ?? this._dialogue.resolveSceneTag('interaction', 'body');
    if (resolved) this._speak(resolved, 'interaction');
  }

  private _playRandom(source: 'ambient' | 'manual' = 'ambient'): void {
    if (this._remoteChat.open || this._chatView?.isOpen || !this._coordination.canSpeak(source)) return;
    const resolved = this._dialogue.resolveRandom();
    if (resolved) this._speak(resolved, source);
  }

  // ---------- 指针输入 ----------

  /**
   * 贴合模式：窗口 CSS 坐标 → 桌面参考布局的归一化坐标。
   * 命中区域/抚摸/注视沿用桌面同一坐标系，窗口贴合后语义不变。
   */
  private _wrapToRefNorm(xCss: number, yCss: number): { nx: number; ny: number } {
    const s = this._contentScaleCss;
    const originInWinX = this._originCssX - this._appliedRectX;
    const originInWinY = this._originCssY - this._appliedRectY;
    const mx = (xCss - originInWinX) / s;
    const my = (originInWinY - yCss) / s; // 模型 Y 轴朝上
    const refH = 675 * PetApp._windowMarginRatio * this._settings.scale;
    const refW = refH * (this._model?.boundsAspect ?? 0.64);
    return {
      nx: 0.5 + (mx * s) / refW,
      ny: 0.5 - (my * s) / refH,
    };
  }

  /** 事件坐标 → 归一化坐标（贴合模式走参考布局换算）。 */
  private _eventNorm(e: PointerEvent): { nx: number; ny: number } {
    const rect = this._canvas.getBoundingClientRect();
    const rw = rect.width || 1;
    const rh = rect.height || 1;
    if (this._wrapWindow && this._model?.isReady()) {
      return this._wrapToRefNorm(e.clientX - rect.left, e.clientY - rect.top);
    }
    if ((this._chatView?.isOpen || (platform === 'android' && !this._wrapWindow)) && this._model?.isReady()) {
      const h = Math.min(rh, rw / this._model.boundsAspect);
      const w = h * this._model.boundsAspect;
      return { nx: Math.min(1, Math.max(0, (e.clientX - rect.left - (rw - w) / 2) / w)),
        ny: Math.min(1, Math.max(0, (e.clientY - rect.top - (rh - h) / 2) / h)) };
    }
    return {
      nx: Math.min(Math.max((e.clientX - rect.left) / rw, 0), 1),
      ny: Math.min(Math.max((e.clientY - rect.top) / rh, 0), 1),
    };
  }

  /** 点击/抚摸使用模型参考坐标；注视仍使用原来的视口坐标。 */
  private _hitEventNorm(e: PointerEvent): { nx: number; ny: number } {
    if (!this._model?.isReady()) return this._eventNorm(e);
    const rect = this._canvas.getBoundingClientRect();
    const { scale, originX, originY } = this._modelViewportTransform();
    // 先到真实 backing-store 像素，包含 DPR 与 canvas 尺寸取整，再反解渲染变换。
    const px = (e.clientX - rect.left) * this._canvas.width / rect.width;
    const py = (e.clientY - rect.top) * this._canvas.height / rect.height;
    const screenOriginX = this._settings.mirror ? this._canvas.width - originX : originX;
    const referenceScale = scale * this._hitAreas.referenceRenderMargin;
    return {
      // 保留屏幕左右方向，镜像只由 HitAreas 消除一次；贴合模式的非居中原点也同步翻转。
      nx: 0.5 + (px - screenOriginX) / (referenceScale * this._model.boundsW),
      ny: 0.5 + (py - originY) / (referenceScale * this._model.boundsH),
    };
  }

  private _updatePointerLook(e: PointerEvent): void {
    if (platform === 'tauri' && e.pointerType === 'mouse') return;
    const n = this._eventNorm(e);
    this._behavior?.updateLookTarget(n.nx, n.ny);
  }

  /** 构造互动上下文（模型参考坐标 + 物理像素 + 真实事件间隔）。 */
  private _ctx(e: PointerEvent, isSecondary: boolean): PointerContext {
    const rect = this._canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this._canvas.width / rect.width : 1;
    const now = performance.now();
    const dt =
      this._lastMoveEventMs > 0
        ? Math.min(Math.max((now - this._lastMoveEventMs) / 1000, 0.001), 0.2)
        : 0.016;
    this._lastMoveEventMs = now;
    const n = this._hitEventNorm(e);
    return {
      normX: n.nx,
      normY: n.ny,
      pxX: (e.clientX - rect.left) * scale,
      pxY: (e.clientY - rect.top) * scale,
      dtSeconds: dt,
      leftPressed: this._leftDown,
      isSecondary,
    };
  }

  private _wirePointerEvents(): void {
    const canvas = this._canvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.button !== 0 && e.button !== 2) || this._activePointerId != null) return;
      this._coordination.activity();
      // 只认角色本体：命中椭圆是语义分区（头/脸/耳…），轮廓外的透明区（头顶、发梢间隙）
      // 不能接管点击/抚摸/拖动。按渲染画布的真实 alpha 判定，跟随任意缩放、镜像与动作姿态。
      if (!this._isOnCharacter(e)) {
        // 触屏点空白处仍让角色看过去（鼠标视线由全局光标驱动）。
        this._updatePointerLook(e);
        return;
      }
      this._cancelSnapAnimation();
      this._activePointerId = e.pointerId;
      // 立即锁住已接受的指针流，不能等下一次渲染采样才通知原生壳。
      this._publishHitMask();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 合成事件/非常规指针没有 active pointer，捕获失败不影响交互
      }
      const n0 = this._hitEventNorm(e);
      const isSecondary =
        e.button === 2 ||
        // 触摸端没有右键：按下头部抚摸区视为抚摸手势起点，
        // 其余区域的单指按住保留给拖动窗口
        (e.pointerType === 'touch' &&
          e.button === 0 &&
          this._hitAreas.isInHeadPetZone(n0.nx, n0.ny));
      const ctx = this._ctx(e, isSecondary);
      this._touchPetting = e.pointerType === 'touch' && isSecondary && e.button === 0;
      this._touchTapCandidate = this._touchPetting;
      this._downScreenX = e.screenX;
      this._downScreenY = e.screenY;
      // 视线跟随：按下即更新目标（轻点不移动也要看向触点）
      this._updatePointerLook(e);

      if (isSecondary) {
        // 右键/触摸头部：只走抚摸，永不触发拖动/点击
        // 声明互动手势：悬浮窗壳不得把这次手势抢成拖动
        if (this._wrapWindow) androidShell()?.setInteracting(true);
        this._interaction?.onPointerDown(ctx);
        return;
      }
      if (e.button !== 0) return;

      this._leftDown = true;
      this._updatePointerLook(e);
      const handled = this._interaction?.onPointerDown(ctx) ?? false;
      if (this._wrapWindow && handled) androidShell()?.setInteracting(true);
      if (!handled) {
        // 左键未被互动接管：进入拖动候选
        this._dragCandidate = true;
        this._dragging = false;
        this._downScreenX = this._lastScreenX = e.screenX;
        this._downScreenY = this._lastScreenY = e.screenY;
        this._syncWindowMetrics();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!e.isPrimary || (this._activePointerId != null && e.pointerId !== this._activePointerId)) return;
      if (this._touchPetting && Math.hypot(e.screenX - this._downScreenX, e.screenY - this._downScreenY) >= PetApp._dragThresholdPx) {
        this._touchTapCandidate = false;
      }
      const ctx = this._ctx(e, (e.buttons & 2) !== 0);
      const handled = this._interaction?.onPointerMove(ctx) ?? false;
      this._updatePointerLook(e);

      if (this._dragCandidate && this._leftDown && !handled) {
        if (!this._dragging) {
          const dx = e.screenX - this._downScreenX;
          const dy = e.screenY - this._downScreenY;
          if (Math.sqrt(dx * dx + dy * dy) >= PetApp._dragThresholdPx) {
            this._dragging = true;
            this._interaction?.procedural.cancelAll();
            this._interaction?.dragReaction.beginDrag();
            if (this._behavior) this._behavior.isDragging = true;
          }
        }
        if (this._dragging) {
          const dx = e.screenX - this._lastScreenX;
          const dy = e.screenY - this._lastScreenY;
          this._interaction?.dragReaction.onDragMove(Math.hypot(dx, dy) * this._scaleFactor / ctx.dtSeconds);
          if (!this._wrapWindow) {
            // 贴合模式：拖动由壳侧原生接管（OnTouchListener 直移窗口）
            this._moveWindowBy(dx, dy);
          }
        }
      }
      this._lastScreenX = e.screenX;
      this._lastScreenY = e.screenY;
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!e.isPrimary || (this._activePointerId != null && e.pointerId !== this._activePointerId)) return;
      this._coordination.activity();
      const viaPetting = e.button === 2 || this._touchPetting;
      const touchTap = this._touchPetting && this._touchTapCandidate && this._interaction?.petting.state === 'pressed';
      const ctx = this._ctx(e, viaPetting);
      const handled = this._interaction?.onPointerUp(ctx) ?? false;
      if (this._wrapWindow) androidShell()?.setInteracting(false);
      this._touchPetting = false;
      if (touchTap) {
        this._interaction?.petting.exitPettingMode('modeChanged');
        this._interaction?.onClick(ctx, false);
      }

      if (e.button === 0 && !viaPetting) {
        if (this._dragging) {
          // 拖动结束：快速拖动反应链（endDrag + 睁大眼 + 台词）
          this._interaction?.onClick(ctx, true);
          this._onDragFinished();
        } else if (this._dragCandidate && !handled) {
          // 普通单击
          this._interaction?.onClick(ctx, false);
        }
        this._resetDragState();
      }
      this._activePointerId = null;
      this._touchTapCandidate = false;
      this._publishHitMask();
    });

    canvas.addEventListener('pointercancel', (e) => {
      if (e?.pointerId != null && this._activePointerId != null && e.pointerId !== this._activePointerId) return;
      // 触摸流被系统/下层窗口截断：按拖动结束处理（保存位置 + 吸附）
      // （贴合模式拖动由壳接管，壳在 UP/CANCEL 回传总位移，这里不重复收尾）
      if (this._dragging && !this._wrapWindow) this._onDragFinished();
      this._cancelInteraction();
      if (this._wrapWindow) androidShell()?.setInteracting(false);
      this._resetDragState();
    });
    canvas.addEventListener('lostpointercapture', (e) => {
      if (e?.pointerId != null && this._activePointerId != null && e.pointerId !== this._activePointerId) return;
      if (this._activePointerId == null && !this._leftDown && !this._touchPetting &&
          !['pressed', 'petting'].includes(this._interaction?.petting.state ?? '')) return;
      if (this._dragging && !this._wrapWindow) this._onDragFinished();
      this._cancelInteraction();
      if (this._wrapWindow) androidShell()?.setInteracting(false);
      this._resetDragState();
    });
    canvas.addEventListener('pointerleave', () => {
      if (platform !== 'tauri' && !this._leftDown) this._behavior?.clearLookTarget();
    });
    window.addEventListener('blur', () => {
      if (this._dragging && !this._wrapWindow) this._onDragFinished();
      this._cancelInteraction();
      if (this._wrapWindow) androidShell()?.setInteracting(false);
      this._resetDragState();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this._dragging && !this._wrapWindow) this._onDragFinished();
        this._cancelInteraction();
        this._resetDragState();
        if (this._wrapWindow) androidShell()?.setInteracting(false);
        this._bubble?.cancel();
      }
    });
  }

  private _resetDragState(): void {
    this._leftDown = false;
    this._dragCandidate = false;
    this._interaction?.dragReaction.cancel();
    if (this._dragging && this._behavior) this._behavior.isDragging = false;
    this._dragging = false;
  }

  /**
   * 结束所有未完成互动：手势被壳层抢成拖动 / pointercancel / 窗口失焦时，
   * 配对的 pointerup 可能永远不到达，需主动收尾，否则按下状态与 expand=96 卡死。
   */
  private _cancelInteraction(): void {
    this._activePointerId = null;
    this._touchPetting = false;
    this._touchTapCandidate = false;
    this._interaction?.cancel();
    this._coordination.activity();
    this._publishHitMask();
  }

  /** 拉取窗口物理位置与 DPI 缩放；旧查询不得覆盖正在提交或播放动画的位置。 */
  private _syncWindowMetrics(): void {
    const win = this._tauriWindow;
    if (!win) return;
    if (this._windowGeometryPending > 0 || this._windowResizeRecovery) return;
    const token = this._snapAnimToken;
    const geometryRevision = this._windowGeometryRevision;
    Promise.all([win.outerPosition(), win.scaleFactor()])
      .then(([pos, sf]) => {
        if (geometryRevision !== this._windowGeometryRevision || this._windowGeometryPending > 0) return;
        this._scaleFactor = sf;
        this._metricsSynced = true;
        if (token === this._snapAnimToken && !this._dragging && !this._windowMoveTask && !this._snapAnimation) {
          this._winPhysX = pos.x;
          this._winPhysY = pos.y;
          this._syncChatAnchor();
        }
      })
      .catch(error => console.warn('Failed to read pet window metrics', error));
  }

  /**
   * 向壳上报模型可见矩形（客户区比例）：底边 = 脚底，横向沿用画布宽
   * （chat 宽 = 锚宽 × 1.18 的既有观感不变）。锚点不能取含渲染余量的
   * 整个画布——余量随窗口线性放大，用画布当锚点，缩放越大 chat 离脚越远。
   * known 传入缩放落定时的实际客户区尺寸（applySettings 路径）；缺省按画布实测。
   * 协议发送相对于客户区的比例矩形，完全不混入屏幕位置或另一次 DPI 采样。
   */
  private _syncChatAnchor(known?: { cssW: number; cssH: number }): void {
    if (platform !== 'tauri' || !this._metricsSynced) return;
    const rect = known
      ? { left: 0, top: 0, width: known.cssW, height: known.cssH }
      : this._canvas.getBoundingClientRect();
    // IPC 不携带屏幕原点；局部比例由 Rust 同一原生矩形快照还原，移动/DPI 不混时刻。
    const viewportW = known?.cssW ?? window.innerWidth;
    const viewportH = known?.cssH ?? window.innerHeight;
    if (!(viewportW > 0 && viewportH > 0)) return;
    let left = rect.left;
    let top = rect.top;
    let w = rect.width || window.innerWidth;
    let h = rect.height || window.innerHeight;
    const b = this._model?.isReady() ? this._model.getStaticBounds() : null;
    if (b && w > 0 && h > 0) {
      // 与 _render 非贴合路径同一套数学：原点 = 视口中心，s = 高/余量/包围盒高。
      const s = h / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
      top += h / 2 - b.maxY * s;
      h = (b.maxY - b.minY) * s;
    }
    const revision = this._chatAnchorRevision = Math.max((this._chatAnchorRevision ?? 0) + 1,
      Math.round((performance.timeOrigin + performance.now()) * 1000));
    const payload = { x: left / viewportW, y: top / viewportH, w: w / viewportW, h: h / viewportH, revision };
    void import('@tauri-apps/api/core')
      .then(m => m.invoke('sync_chat_anchor', payload))
      .catch(error => console.warn('Failed to synchronize local chat anchor', error));
  }

  /** 拖动只跟随指针，不在移动过程中吸附或限制位置。 */
  private _moveWindowBy(deltaCssX: number, deltaCssY: number): void {
    if (platform === 'android') {
      // 壳侧同步应用增量（乘 density），无缓存竞态问题
      androidShell()?.moveWindowBy(deltaCssX, deltaCssY);
      return;
    }
    const win = this._tauriWindow;
    if (!win || !this._metricsSynced) return;
    this._winPhysX += deltaCssX * this._scaleFactor;
    this._winPhysY += deltaCssY * this._scaleFactor;
    void this._submitWindowPos().catch(() => this._syncWindowMetrics());
  }

  /** 串行提交窗口位置；拖动合并目标，动画等待实际提交后再采样下一帧。 */
  private _submitWindowPos(): Promise<void> {
    const win = this._tauriWindow;
    if (!win) return Promise.resolve();
    const revision = this._windowPositionRevision = (this._windowPositionRevision ?? 0) + 1;
    this._windowPositionKind = 'move';
    const task = this._queueWindowGeometry(async () => {
      const m = await import('@tauri-apps/api/window');
      if (revision !== this._windowPositionRevision) return;
      const x = Math.round(this._winPhysX), y = Math.round(this._winPhysY);
      await this._setWindowPositionVerified(new m.PhysicalPosition(x, y));
      this._windowResizeRemainder = { x: 0, y: 0 };
    }, 'Failed to move pet window').finally(() => {
      if (this._windowMoveTask === task) this._windowMoveTask = null;
    });
    this._windowMoveTask = task;
    return task;
  }

  // ---------- 渲染循环 ----------

  public getCanvas(): HTMLCanvasElement {
    return this._canvas;
  }

  /** 调试句柄（CDP 验证用）。 */
  public get interaction(): InteractionService | null {
    return this._interaction;
  }
  public get dialogue(): DialogueStore {
    return this._dialogue;
  }
  public get model(): PetModel | null {
    return this._model;
  }

  private _resizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const rect = this._canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  }

  private _startLoop(): void {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = performance.now();
    requestAnimationFrame((t) => this._frame(t));
    // 后台/熄屏时停止渲染循环（Android 壳与浏览器通用）
    document.addEventListener('visibilitychange', () => {
      this.setPaused(document.hidden);
      // 后台期间 GL 上下文被回收过 → 回前台整页重建（否则画面永久冻结）
      if (!document.hidden) this._reloadAfterContextLoss();
    });
  }

  /**
   * GL 上下文丢失后的整页重建。防重载死循环：
   * 2 分钟内连续重建超 3 次放弃（驱动异常时保持现状，不劣化）。
   */
  private _reloadAfterContextLoss(): void {
    if (!this._glContextLost) return;
    try {
      const now = Date.now();
      const rec = JSON.parse(
        sessionStorage.getItem('glRecovery') ?? '{"n":0,"t":0}'
      ) as { n: number; t: number };
      const n = now - rec.t > 120000 ? 1 : rec.n + 1;
      sessionStorage.setItem('glRecovery', JSON.stringify({ n, t: now }));
      if (n > 3) return;
    } catch {
      // 存储不可用：照常重建
    }
    location.reload();
  }

  /** 暂停/恢复渲染循环（屏幕熄灭、切后台）。 */
  public setPaused(paused: boolean): void {
    if (this._paused === paused) return;
    this._paused = paused;
    if (paused) {
      this._chat?.stop();
      this._cancelInteraction();
      this._resetDragState();
      this._bubble?.cancel();
      androidShell()?.setInteracting(false);
      this._chatPerformance?.cancel();
    }
    if (!paused && this._running) {
      this._lastFrameTime = performance.now();
      requestAnimationFrame((t) => this._frame(t));
    }
  }

  /** 壳事件入口（Android 壳经 evaluateJavascript 调用）。 */
  public onShellEvent(event: string): void {
    if (event === 'screen-off' || event === 'pause') this.setPaused(true);
    else if (event === 'screen-on' || event === 'resume') {
      if (platform === 'android') this.applySettings(loadSettings(), this._wrapWindow);
      this.setPaused(false);
      this._reloadAfterContextLoss();
    } else if (event === 'display-changed' && this._wrapWindow) {
      this._applyWindowSettingsAndroid(this._settings, false);
    }
  }

  /**
   * 悬浮窗之外的触摸（壳经 ACTION_OUTSIDE 上报，屏幕绝对坐标 CSS px）：
   * 视线跟随到触点。注意 Android 多数版本/ROM 出于隐私只给 (0,0)——
   * 此时无法定向，忽略（窗内触摸的跟随不受影响）。
   */
  public onOutsideTouch(xCss: number, yCss: number): void {
    if (!this._wrapWindow) return;
    if (xCss === 0 && yCss === 0) return; // 坐标被系统抹掉：无法定向
    const n = this._wrapToRefNorm(
      xCss - this._appliedRectX,
      yCss - this._appliedRectY
    );
    this._behavior?.updateLookTarget(n.nx, n.ny);
  }

  /**
   * 悬浮窗原生拖动开始（壳 OnTouchListener 接管窗口搬运）。
   * JS 侧的拖动候选作废：窗口位置由壳独占，本对象只同步状态。
   */
  public onNativeDragStart(): void {
    this._nativeDragging = true;
    this._cancelSnapAnimation();
    this._leftDown = false;
    this._dragCandidate = false;
    this._dragging = false;
    // 壳在 MOVE 超阈值时抢走手势，DOWN 已透传给 WebView——
    // 壳侧会先补发 ACTION_CANCEL（触发 pointercancel 收尾），这里兜底再清一次：
    // 抚摸按下态不残留，jsInteracting 也复位（否则后续拖动被壳的 !jsInteracting 拦截）
    this._cancelInteraction();
    androidShell()?.setInteracting(false);
    this._interaction?.dragReaction.beginDrag();
    if (this._behavior) this._behavior.isDragging = true;
  }

  /**
   * 悬浮窗原生拖动结束：壳回传全程位移（CSS px）。
   * 原点/已应用矩形同步平移（渲染锚定不变），随后吸附归位（缓动）+ 持久化。
   */
  /** 原生贴边动画播完：位置已是终点，持久化。 */
  public onNativeSnapEnd(): void {
    if (!this._nativeSnapping) return;
    this._nativeSnapping = false;
    this._persistWrapOrigin();
  }

  /** 原生贴边动画被抓起打断：窗口停在 (x,y)，原点按窗口实际位移回退。 */
  public onNativeSnapInterrupted(xCss: number, yCss: number): void {
    if (!this._nativeSnapping) return;
    this._nativeSnapping = false;
    this._originCssX += xCss - this._appliedRectX;
    this._originCssY += yCss - this._appliedRectY;
    this._appliedRectX = xCss;
    this._appliedRectY = yCss;
  }

  public onNativeDragEnd(dxCss: number, dyCss: number, maxSpeedPxPerSec: number, cancelled: boolean): void {
    this._coordination.activity();
    this._nativeDragging = false;
    this._cancelSnapAnimation();
    this._originCssX += dxCss;
    this._originCssY += dyCss;
    this._appliedRectX += dxCss;
    this._appliedRectY += dyCss;
    if (this._behavior) this._behavior.isDragging = false;
    if (cancelled) this._interaction?.dragReaction.cancel();
    else {
      this._interaction?.dragReaction.onDragMove(maxSpeedPxPerSec);
      this._interaction?.onClick({ normX: 0.5, normY: 0.5, pxX: 0, pxY: 0,
        dtSeconds: 0.016, leftPressed: false, isSecondary: false }, true);
    }
    this._onDragFinished();
  }

  /** 调整帧率上限（省电模式 15fps）。 */
  public setFpsCap(n: number): void {
    this._fpsCap = Math.min(Math.max(n, 5), 60);
  }

  private _frame(t: number): void {
    if (!this._running || this._paused) return;

    const minInterval = 1000 / this._fpsCap;
    if (t - this._lastFrameTime < minInterval - 1) {
      requestAnimationFrame((t2) => this._frame(t2));
      return;
    }
    // 帧间隔累积推进；长时间欠采样（切后台回来）时重置锚点
    this._lastFrameTime += minInterval;
    if (t - this._lastFrameTime > minInterval * 2) {
      this._lastFrameTime = t;
    }

    const dt = minInterval / 1000;
    // 画布尺寸在渲染帧内同步：重置缓冲后立即重绘，合成器永远拿不到空帧
    this._resizeCanvas();
    // 每帧从同一个物理坐标源换算；鼠标静止时窗口移动/镜像/拖动结束也能恢复。
    if (this._globalMouse && this._metricsSynced && !this._wrapWindow) {
      const rect = this._canvas.getBoundingClientRect();
      const w = rect.width * this._scaleFactor;
      const h = rect.height * this._scaleFactor;
      if (w > 0 && h > 0) this._behavior?.updateLookTarget(
        (this._globalMouse.x - this._winPhysX - rect.left * this._scaleFactor) / w,
        (this._globalMouse.y - this._winPhysY - rect.top * this._scaleFactor) / h);
    }
    this._update(dt);
    if (platform === 'tauri') this._reportChatLayout();
    // 贴合模式先下发窗口矩形（渲染矩阵使用同一套矩形，变化有一帧过渡）
    if (this._wrapWindow) this._syncWrapWindow();
    this._render();
    this._positionBubble();
    this._positionChatLauncher();
    // 壳命中层：低频上报像素占用掩码（透明区域触摸穿透）
    this._maybeSendHitMask();

    requestAnimationFrame((t2) => this._frame(t2));
  }

  /**
   * 气泡锚定角色头部（可见才算，~30fps 几个 DOM 读写的成本可忽略）：
   * 气泡底边 = 动态剪影顶 − 6px。窗口顶部气泡带永远容得下
   * （带 88 ≥ 气泡限高 76 + 间隙），不再出现气泡钉在窗口顶「飞天」。
   */
  private _positionBubble(): void {
    const bubble = this._bubble;
    if (!bubble?.isActive) return;
    const b = this._model?.getDynamicBounds();
    if (!b) return;
    const rect = this._canvas.getBoundingClientRect();
    const vpW = rect.width || 1;
    const vpH = rect.height || 1;
    let headTopCss: number;
    if (this._wrapWindow) {
      // 剪影顶（屏幕 CSS）→ 窗口内坐标
      headTopCss = this._originCssY - b.maxY * this._contentScaleCss - this._appliedRectY;
    } else {
      // 非贴合：原点锚在视口中心，比例与非贴合渲染一致（CSS 口径）
      const fitH = (this._chatView?.isOpen || platform === 'android') ? Math.min(vpH, vpW / this._model.boundsAspect) : vpH;
      const natural = fitH / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
      // 缩放补间以静态脚底为锚：头顶 = 脚底 − (maxY − minY)·当前比例，气泡跟着角色一起长高。
      const s = this._scaleTweenValue() ?? natural;
      const minY = this._model.getStaticBounds().minY;
      headTopCss = vpH / 2 - minY * natural - (b.maxY - minY) * s;
    }
    const el = bubble.el;
    // 小窗口适配：气泡按视口等比缩小（transform scale 保形缩放，
    // 不重排成窄长列），避免小缩放下气泡占满窗口盖住角色/被窗口裁切
    const fitKey = `${el.textContent}|${Math.round(vpW)}x${Math.round(vpH)}`;
    if (fitKey !== this._bubbleFitKey) {
      this._bubbleFitKey = fitKey;
      // 先量自然尺寸：width:max-content 摆脱 fit-content 被包含块宽度截断
      // （否则小窗口量出的是视口宽、多行高，缩放系数失真）
      el.style.transform = 'none';
      el.style.width = 'max-content';
      el.style.maxWidth = this._wrapWindow ? '260px' : '300px';
      const w0 = el.offsetWidth || 1;
      const h0 = el.offsetHeight || 1;
      let k = Math.min(1, (vpW * 0.94) / w0, (vpH * 0.62) / h0);
      k = Math.min(Math.max(k, 0.3), 1);
      if (k < 0.999) {
        // 布局盒比窗口宽时 margin auto 居中失效（Blink 把 auto 边距钳为 0，
        // 盒子左对齐、缩放中心偏到窗口右侧 → 气泡右半边被窗口裁掉）。
        // 改用 left:50% + translateX(-50%) 强制居中（不依赖 auto 边距），
        // 再在变换里叠加缩放；origin 取顶部，top 按缩放后高度定位才精确。
        el.style.margin = '0';
        el.style.left = '50%';
        el.style.right = 'auto';
        el.style.width = `${w0}px`;
        el.style.maxWidth = 'none';
        el.style.transformOrigin = '50% 0%';
        el.style.transform = `translateX(-50%) scale(${k})`;
      } else {
        el.style.margin = '';
        el.style.left = '';
        el.style.right = '';
        el.style.maxWidth = '';
      }
      this._bubbleScaledH = h0 * k;
    }
    const top = Math.max(4, headTopCss - this._bubbleScaledH - 6);
    el.style.top = `${Math.round(top)}px`;
  }

  /**
   * 聊天入口逐帧钉在脚底：bottom = 窗口高 − 脚底高 + 固定间隙，
   * 数学与 _render 非贴合路径同源（原点=视口中心，s=高/余量/包围盒）。
   * 旧实现把按钮钉在窗口底（bottom:8px），窗口含 1.22 渲染余量，缩放越大
   * 按钮离脚越远。大小随缩放档位等比（--launcher-k，夹 0.7–1.6），
   * 与 chat 窗宽 = 模型宽 × 1.18 同一套「UI 随模型缩放」语言。
   */
  private _positionChatLauncher(): void {
    const launcher = this._chatLauncher;
    if (!launcher || launcher.hidden || this._wrapWindow) return;
    const b = this._model?.getStaticBounds();
    if (!b) return;
    const rect = this._canvas.getBoundingClientRect();
    if (!rect.height) return;
    const s = rect.height / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
    const feetCss = rect.height / 2 - b.minY * s;
    const bottom = Math.max(4, Math.round(rect.height - feetCss + PetApp._launcherGapCss));
    if (bottom !== this._launcherBottomCss) {
      this._launcherBottomCss = bottom;
      launcher.style.bottom = `${bottom}px`;
    }
    // 入口大小跟角色当前显示比例走（缩放补间期间同步长大/缩小）。
    const shown = (this._scaleTweenValue() ?? s) / s;
    const k = Math.round(Math.min(1.6, Math.max(0.7, rect.height * shown / (675 * PetApp._windowMarginRatio))) * 1000) / 1000;
    if (k !== this._launcherScaleK) {
      this._launcherScaleK = k;
      launcher.style.setProperty('--launcher-k', String(k));
    }
  }

  private _update(dt: number): void {
    // 互动层先算平滑值并写入模型通道，模型 update 时统一应用
    this._chatPerformance?.tick();
    this._interaction?.tick(dt * 1000);
    this._moodEngine?.tick(dt);
    this._model?.update(dt);
  }

  /** 模型 → backing-store 像素：渲染与命中反解共享同一变换。 */
  private _modelViewportTransform(): { scale: number; originX: number; originY: number } {
    if (this._wrapWindow) {
      const base = {
        scale: this._contentScaleCss * this._dpr,
        originX: (this._originCssX - this._appliedRectX) * this._dpr,
        originY: (this._originCssY - this._appliedRectY) * this._dpr,
      };
      // 悬浮窗缩放补间：外窗已一次给足终点尺寸，角色在窗内以静态脚底为锚过渡。
      const tweenCss = this._scaleTweenValue();
      if (tweenCss == null || this._contentScaleCss <= 0) return base;
      const k = tweenCss / this._contentScaleCss;
      const b = this._model.getStaticBounds();
      const footX = base.originX + ((b.minX + b.maxX) / 2) * base.scale;
      const footY = base.originY - b.minY * base.scale;
      return { scale: base.scale * k, originX: footX + (base.originX - footX) * k, originY: footY + (base.originY - footY) * k };
    }
    // 包围盒适配，与 native SetupModelMatrix/Render 的布局口径一致。
    const fitH = (this._chatView?.isOpen || platform === 'android')
      ? Math.min(this._canvas.height, this._canvas.width / this._model.boundsAspect) : this._canvas.height;
    const natural = fitH / PetApp._renderMarginRatio / this._model.boundsH;
    const originX = this._canvas.width / 2, originY = this._canvas.height / 2;
    const tweenCss = this._scaleTweenValue();
    if (tweenCss == null || natural <= 0) return { scale: natural, originX, originY };
    // 以静态脚底为锚缩放（缓冲坐标未镜像；镜像是画布 CSS 翻转）：脚底不动，角色向上生长/收缩。
    const k = tweenCss * this._dpr / natural;
    const b = this._model.getStaticBounds();
    const footX = originX + ((b.minX + b.maxX) / 2) * natural;
    const footY = originY - b.minY * natural;
    return { scale: natural * k, originX: footX + (originX - footX) * k, originY: footY + (originY - footY) * k };
  }

  /** 当前补间值（CSS 口径）；无补间或已播完落定返回 null。 */
  private _scaleTweenValue(now = performance.now()): number | null {
    const tween = this._scaleTween;
    if (!tween) return null;
    if (tween.start == null) return tween.from;
    const t = Math.min(1, Math.max(0, (now - tween.start) / PetApp._scaleTweenMs));
    if (t >= 1 && tween.settled) {
      this._scaleTween = null;
      if (this._wrapWindow) this._rectDirty = true; // 缩小补间结束：外窗收回终点尺寸
      return null;
    }
    const eased = 1 - (1 - t) ** 3;
    return tween.from + (tween.to - tween.from) * eased;
  }

  /** 给定画布 CSS 尺寸下的自然适配比例（CSS px / 模型单位），与 _modelViewportTransform 同式。 */
  private _naturalScaleCss(width: number, height: number, chatOpen: boolean): number {
    if (!this._model?.isReady()) return 0;
    const fitH = chatOpen ? Math.min(height, width / this._model.boundsAspect) : height;
    return fitH / PetApp._renderMarginRatio / this._model.boundsH;
  }

  private _render(): void {
    const gl = this._gl;
    if (gl.isContextLost()) return;

    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (!this._model?.isReady()) return;

    const vpW = this._canvas.width;
    const vpH = this._canvas.height;
    const modelMatrix = this._model.getModelMatrix();
    modelMatrix.loadIdentity();
    const { scale, originX, originY } = this._modelViewportTransform();
    modelMatrix.scale(scale, -scale); // 模型 Y 轴朝上，视口 Y 轴朝下
    modelMatrix.translate(originX, originY);

    // 视口像素 -> NDC（y 翻转）
    const projection = new CubismMatrix44();
    projection.scale(2.0 / vpW, -2.0 / vpH);
    projection.translate(-1.0, 1.0);

    this._model.draw(projection);
  }

  // ---------- 悬浮窗内容贴合（固定窗口架构） ----------

  /**
   * 固定窗口矩形（CSS px，相对屏幕）。
   *
   * 成熟路线（与 Windows 版/Flutter 版同构）：窗口尺寸只随缩放档位变化，
   * 按静态包围盒 + 余量一次给足——动作在模型画布内活动，全程包容，
   * 逐帧不需要任何 grow/shrink/包络跟踪，从根上杜绝重排抽搐。
   * 透明区域的交互由像素掩码穿透接管（见 _maybeSendHitMask）。
   *
   * 布局：顶部预留气泡带，下方内容区 = 675×1.18×scale（与非贴合模式同基准），
   * 静态剪影中心锚在内容区中心（四向等距余量，动作向任何方向甩都有空间）。
   */
  private _fixedWindowRect(): { x: number; y: number; w: number; h: number } {
    const band = PetApp._WRAP_BUBBLE_BAND;
    const b = this._model?.getStaticBounds() ?? null;
    // 缩放补间期间按起止两端较大的比例给窗口（脚底同锚，大窗包住小角色），不逐帧改窗。
    const tween = this._scaleTween;
    const s0 = this._contentScaleCss;
    const s = tween && s0 > 0 ? Math.max(s0, tween.from) : s0;
    const k = s0 > 0 ? s / s0 : 1;
    const baseH = 675 * PetApp._windowMarginRatio * this._settings.scale * k;
    const baseW =
      baseH * (this._model?.isReady() ? this._model.boundsAspect : 512 / 768);
    // 比例 s 下保持脚底不动的原点（模型 Y 轴朝上 → 屏幕坐标减）
    const originY = this._originCssY + (b ? b.minY * (s - s0) : 0);
    const ccx = this._originCssX + (b ? ((b.minX + b.maxX) / 2) * s0 : 0);
    const ccy = originY - (b ? ((b.minY + b.maxY) / 2) * s : 0);
    const w = baseW;
    const h = baseH + band;
    return {
      x: ccx - w / 2,
      y: ccy - baseH / 2 - band,
      w,
      h,
    };
  }

  /**
   * 把固定窗口矩形同步给壳。仅在心形变化时下发：
   * 初始化 / 缩放档位变更 / 模型加载 / 吸附归位动画逐帧（纯平移，无表面重配）。
   * 动作播放、摇摆、物理晃动完全不触发本方法——窗口纹丝不动。
   */
  private _syncWrapWindow(): void {
    if (this._nativeDragging) return; // 原生拖动期间窗口由壳独占
    const shell = androidShell();
    if (!shell) return;
    if (this._rectInited && !this._rectDirty) return;
    this._rectDirty = false;

    const r = this._fixedWindowRect();
    const L = Math.round(r.x);
    const T = Math.round(r.y);
    const W = Math.max(8, Math.round(r.w));
    const H = Math.max(8, Math.round(r.h));
    if (
      this._rectInited &&
      L === this._appliedRectX &&
      T === this._appliedRectY &&
      W === this._appliedRectW &&
      H === this._appliedRectH
    ) {
      return;
    }
    shell.setWindowRect(L, T, W, H);
    this._appliedRectX = L;
    this._appliedRectY = T;
    this._appliedRectW = W;
    this._appliedRectH = H;
    this._rectInited = true;
  }

  // ---------- 鼠标穿透命中掩码（Windows 壳） ----------

  /** 把渲染 alpha 缩成占用掩码发给壳命中层（变化才发，~8Hz）。 */
  private _maybeSendHitMask(): void {
    const androidWrap = platform === 'android' && this._wrapWindow;
    if (!this._hitMaskSend && !androidWrap) return;
    if (!this._model?.isReady()) return;
    const interacting = this._isPointerInteracting();
    const geometry = this._hitMaskGeometryKey();
    const now = performance.now();
    if (
      now - this._hitMaskLastMs < 120 &&
      interacting === this._hitMaskInteracting &&
      geometry === this._hitMaskGeometry
    ) {
      return;
    }
    this._hitMaskLastMs = now;

    const cols = PetApp._hitMaskCols;
    const rows = Math.max(
      1,
      Math.round((cols * window.innerHeight) / Math.max(1, window.innerWidth))
    );
    if (!this._hitMaskCanvas) {
      this._hitMaskCanvas = document.createElement('canvas');
      this._hitMaskCtx = this._hitMaskCanvas.getContext('2d', {
        willReadFrequently: true,
      });
    }
    if (
      this._hitMaskCanvas.width !== cols ||
      this._hitMaskCanvas.height !== rows
    ) {
      this._hitMaskCanvas.width = cols;
      this._hitMaskCanvas.height = rows;
    }
    const ctx = this._hitMaskCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, cols, rows);
    // 掩码覆盖整个原生窗口：角色画布现在可以只占窗口的一部分。
    const canvasRect = this._canvas.getBoundingClientRect();
    const sx = cols / Math.max(1, window.innerWidth);
    const sy = rows / Math.max(1, window.innerHeight);
    ctx.save();
    ctx.translate(canvasRect.left * sx, canvasRect.top * sy);
    if (this._settings.mirror) {
      ctx.translate(canvasRect.width * sx, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this._canvas, 0, 0, canvasRect.width * sx, canvasRect.height * sy);
    ctx.restore();
    // 对话面板、输入框、聊天按钮可点击；其余透明区域继续穿透。
    ctx.fillStyle = '#fff';
    for (const r of this._chatView?.hitRects() ?? (this._chatLauncher && !this._chatLauncher.hidden ? [this._chatLauncher.getBoundingClientRect()] : [])) {
      ctx.fillRect(Math.floor(r.left * sx), Math.floor(r.top * sy), Math.ceil(r.width * sx) + 1, Math.ceil(r.height * sy) + 1);
    }
    if (this._shellSyncNotice) {
      const r = this._shellSyncNotice.getBoundingClientRect();
      ctx.fillRect(Math.floor(r.left * sx), Math.floor(r.top * sy), Math.ceil(r.width * sx) + 1, Math.ceil(r.height * sy) + 1);
    }
    const img = ctx.getImageData(0, 0, cols, rows).data;
    const data = new Uint8Array(cols * rows);
    for (let i = 0; i < data.length; i++) {
      data[i] = img[i * 4 + 3] > PetApp._hitMaskAlphaThreshold ? 1 : 0;
    }
    if (
      interacting === this._hitMaskInteracting &&
      data.length === this._hitMaskData.length &&
      rows === this._hitMaskRows &&
      data.every((v, i) => v === this._hitMaskData[i]) &&
      geometry === this._hitMaskGeometry &&
      (androidWrap || now - this._hitMaskSentMs < 1000)
    ) {
      return; // Windows 仍需在原生 1.5s TTL 前刷新；相同剪影不能吞掉几何变化。
    }
    this._hitMaskData = data;
    this._hitMaskRows = rows;
    this._hitMaskInteracting = interacting;
    this._hitMaskGeometry = geometry;
    if (androidWrap) {
      // Android 悬浮窗：壳在 ACTION_DOWN 命中透明格时临时切 NOT_TOUCHABLE 穿透
      let csv = '';
      for (let i = 0; i < data.length; i++) csv += data[i];
      androidShell()?.setHitMask(cols, rows, csv);
      return;
    }
    this._publishHitMask();
  }

  private _isPointerInteracting(): boolean {
    const petting = this._interaction?.petting.state;
    return this._activePointerId != null || petting === 'pressed' || petting === 'petting'
      || (this._chatView?.pointerActive ?? false);
  }

  private _hitMaskGeometryKey(): string {
    return [this._winPhysX, this._winPhysY, window.innerWidth, window.innerHeight, this._scaleFactor].join(':');
  }

  /** 只重发缓存掩码，不在输入回调读取/改写渲染缓冲。 */
  private _publishHitMask(): void {
    if (platform !== 'tauri' || !this._hitMaskSend || !this._hitMaskData.length) return;
    this._hitMaskInteracting = this._isPointerInteracting();
    this._hitMaskGeometry = this._hitMaskGeometryKey();
    this._hitMaskSentMs = performance.now();
    this._hitMaskSend({
      cols: PetApp._hitMaskCols,
      rows: this._hitMaskRows,
      data: Array.from(this._hitMaskData),
      interacting: this._hitMaskInteracting,
      winX: this._winPhysX,
      winY: this._winPhysY,
      winW: Math.round(window.innerWidth * this._scaleFactor),
      winH: Math.round(window.innerHeight * this._scaleFactor),
    });
  }

  /**
   * 事件位置附近是否有角色不透明像素：在触点周围半径内采样渲染缓冲 alpha。
   * 半径按 CSS px 计（鼠标 6、触摸 10，乘 dpr 换到缓冲像素），不随模型缩放变化——
   * 小缩放下手指也点得中，大缩放下头顶透明区也不再被当作角色。
   * 读的是上一帧渲染结果；Android 关闭了 preserveDrawingBuffer，按下时先同步重绘一帧。
   */
  private _isOnCharacter(e: PointerEvent): boolean {
    const gl = this._gl;
    if (!this._model?.isReady() || !gl || gl.isContextLost()) return this._maskOpaqueAt(e);
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return true;
    const sx = this._canvas.width / rect.width;
    const sy = this._canvas.height / rect.height;
    // 镜像是画布 CSS 翻转：屏幕左右与缓冲左右相反。
    const lx = (e.clientX - rect.left) * sx;
    const bx = this._settings.mirror ? this._canvas.width - lx : lx;
    const by = this._canvas.height - (e.clientY - rect.top) * sy; // GL 原点在左下
    const radius = Math.max(2, Math.round((e.pointerType === 'mouse' ? 6 : 10) * sx));
    const x0 = Math.max(0, Math.floor(bx - radius)), y0 = Math.max(0, Math.floor(by - radius));
    const x1 = Math.min(this._canvas.width, Math.ceil(bx + radius)), y1 = Math.min(this._canvas.height, Math.ceil(by + radius));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return false;
    if (platform === 'android') this._render();
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._frameBuffer);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const r2 = radius * radius;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x0 + x + 0.5 - bx, dy = y0 + y + 0.5 - by;
      if (dx * dx + dy * dy <= r2 && px[(y * w + x) * 4 + 3] > PetApp._hitMaskAlphaThreshold) return true;
    }
    return false;
  }

  /** 画布不可读（未就绪/上下文丢失）时退回原生穿透掩码；没有掩码则放行。 */
  private _maskOpaqueAt(e: PointerEvent): boolean {
    if (!this._hitMaskData?.length || !this._hitMaskRows) return true;
    const cols = PetApp._hitMaskCols;
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((e.clientX / Math.max(1, window.innerWidth)) * cols)));
    const gy = Math.min(this._hitMaskRows - 1, Math.max(0, Math.floor((e.clientY / Math.max(1, window.innerHeight)) * this._hitMaskRows)));
    return this._hitMaskData[gy * cols + gx] !== 0;
  }
}
