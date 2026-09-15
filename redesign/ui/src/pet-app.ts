import { ChatController, type ChatStorage } from './chat/controller';
import { MskAuth } from './chat/msk/auth';
import { ChatView } from './chat/view';
import { ChatPerformance } from './chat/performance';
import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { PetModel } from './pet-model';
import { InteractionCoordinator, type SpeechSource } from './interaction/coordination';
import { DialogueStore, type ResolvedDialogue } from './dialogue/dialogue';
import { DialogueBubble } from './dialogue/bubble';
import { HitAreas } from './interaction/hit-areas';
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
  isTouchDevice,
  androidShell,
  isAndroidOverlay,
} from './platform';

/** Tauri 窗口句柄（浏览器环境为 null，拖动退化为不可用）。 */
type TauriWindow = import('@tauri-apps/api/window').Window;

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
  private _hitAreas = new HitAreas();
  private _bubble: DialogueBubble = null;
  private _interaction: InteractionService = null;
  private _behavior: BehaviorService = null;
  private _moodEngine: MoodEngine = null;
  private _ai: PetAI = null;
  private _remoteChat = { open: false, busy: false, typing: false };
  private _chatLauncher: HTMLElement | null = null;
  private _chat: ChatController | null = null;
  private _chatView: ChatView | null = null;
  private _chatPerformance: ChatPerformance | null = null;
  private _windowSettingsRevision = 0;
  private _coordination = new InteractionCoordinator(() => ({
    interacting: this._leftDown || this._dragging || this._nativeDragging || (this._interaction?.isBusy ?? false),
    speaking: this._remoteChat.busy || this._remoteChat.typing || (this._bubble?.isActive ?? false) || (this._chat?.busy ?? false) ||
      (this._chatPerformance?.active ?? false) || (this._chatView?.typing ?? false),
    paused: this._paused || !this._running,
  }));

  // Tauri 窗口拖动
  private _tauriWindow: TauriWindow | null = null;
  private _winPhysX = 0;
  private _winPhysY = 0;
  private _scaleFactor = 1;
  private _metricsSynced = false;
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
  /** 吸附归位动画令牌：新拖动/新吸附自增打断旧动画。 */
  private _snapAnimToken = 0;
  private _snapHintTimer: ReturnType<typeof setTimeout> | null = null;
  private _globalMouse: { x: number; y: number } | null = null;
  private _dpr = 1;
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
  private _hitMaskSend: ((args: Record<string, unknown>) => void) | null = null;
  private _hitMaskInteracting = false;

  // 设置
  private _settings: PetSettings = loadSettings();

  // 指针状态
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

  /**
   * 渲染动作余量：模型渲染尺寸 = 视口 / 1.22。
   * Aliya 自编动作（tools/gen-motions.py）实测最差帧：水平 maxX 0.374 /
   * 垂直 maxY 0.517（模型单位，静态包围盒 0.636×1.011）；需求 水平 1.156 /
   * 垂直 1.023，1.22 = 最差 1.156 × 1.05 安全余量（测量方法见 docs/ACTIONS.md）。
   */
  private static readonly _renderMarginRatio = 1.22;

  /** 窗口尺寸余量：窗口 = 675×scale × 1.18（对齐 Flutter ComputeTargetPixelSize）。 */
  private static readonly _windowMarginRatio = 1.18;

  /** 悬浮窗顶部永久预留的气泡带高度（CSS px，≈3 行气泡 + 间隙）。 */
  private static readonly _WRAP_BUBBLE_BAND = 88;

  /** 气泡适配缓存：文本/视口变化时重算等比缩放（见 _positionBubble）。 */
  private _bubbleFitKey = '';
  private _bubbleScaledH = 0;

  /** 鼠标穿透掩码列数（行数按窗口纵横比推导）。 */
  private static readonly _hitMaskCols = 48;

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

    this._gl = this._canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      // 窗口缩放过程中系统会重合成上一帧：preserve=false 时呈现后缓冲失效，
      // 合成到的是黑/白闪帧；true 让旧帧被拉伸显示直到新一帧就绪
      // （鼠标穿透的 readPixels 命中掩码也依赖保留的缓冲）
      preserveDrawingBuffer: true,
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
      const shell = androidShell();
      if (shell) {
        try {
          const m = JSON.parse(shell.getMetrics()) as {
            screenW: number;
            screenH: number;
          };
          if (this._originUnset() && m.screenW > 0) {
            this._originCssX = m.screenW * 0.9;
            this._originCssY = m.screenH * 0.45;
          }
        } catch {
          // 保持原点
        }
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
        this._tauriWindow.onScaleChanged(() => this._syncWindowMetrics()).catch(() => {});
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
    this._wireSettingsSync();
    this._startLoop();
    console.log('[pet] model + logic layer ready');

    // 悬浮窗首次启动（未保存过位置）：默认停在屏幕右下习惯位
    if (this._wrapWindow) {
      const shell = androidShell();
      if (shell) {
        try {
          const m = JSON.parse(shell.getMetrics()) as {
            density: number;
            screenW: number;
            screenH: number;
          };
          console.log(
            `[pet] wrap metrics: inner=${window.innerWidth}x${window.innerHeight} ` +
              `dpr=${window.devicePixelRatio} shellDensity=${m.density} ` +
              `screen=${m.screenW}x${m.screenH}`
          );
          if (this._originUnset()) {
            this._originCssX = m.screenW * 0.9;
            this._originCssY = m.screenH * 0.45;
          }
        } catch {
          // 保持原点
        }
      }
    }

    // 启动时全量应用设置（含窗口位置/缩放/置顶恢复）
    this.applySettings(this._settings, true);
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

  /** Android 悬浮窗不创建聊天 UI，也不读取/发送会话。 */
  private _initializeChat(): void {
    if (this._wrapWindow) return;
    let storage: ChatStorage | undefined;
    try { storage = window.localStorage; } catch { /* 存储被禁用时使用内存。 */ }
    this._chat = new ChatController({ label: '未连接', async *reply(): AsyncGenerator<never> { throw new Error('请先连接 Misskey。'); } });
    this._chatPerformance = new ChatPerformance({
      expressions: () => this._ai?.expressions() ?? [],
      actions: () => this._ai?.state().actions ?? [],
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

  /** 托盘「切换尺寸」：在百分比域循环 10%→50%→100%（档位由设备范围换算，不会越界）。 */
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
    this._settings = s;
    const revision = ++this._windowSettingsRevision;
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
      this._applyWindowSettingsAndroid(s, restoreWindow);
      return;
    }
    const win = this._tauriWindow;
    if (win) {
      win.setAlwaysOnTop(s.alwaysOnTop).catch(() => {});
      import('@tauri-apps/api/window')
        .then(async (m) => {
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
          // 缩放时保持角色脚底中心不动：窗口向左右等量扩缩，底边保持原位。
          // 启动恢复则以保存的位置为准，不做自动拉回屏幕。
          const beforePos = await win.outerPosition().catch((): null => null);
          const beforeSize = await win.outerSize().catch((): null => null);
          await win.setSize(new m.LogicalSize(width, height)).catch((): void => {});
          if (revision !== this._windowSettingsRevision) return;
          let target: { x: number; y: number } | null = null;
          if (restoreWindow && s.posX != null && s.posY != null) {
            target = { x: s.posX, y: s.posY };
          } else if (beforePos && beforeSize) {
            const afterSize = await win.outerSize().catch((): null => null);
            if (afterSize) target = {
              x: Math.round(beforePos.x + (beforeSize.width - afterSize.width) / 2),
              y: beforePos.y + beforeSize.height - afterSize.height,
            };
          }
          if (target) {
            await win.setPosition(new m.PhysicalPosition(target.x, target.y)).catch(() => {});
            this._winPhysX = target.x; this._winPhysY = target.y;
            this._settings.posX = target.x; this._settings.posY = target.y;
            saveSettings(this._settings);
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Android：App 内为全屏容器无窗口操作；悬浮窗走内容贴合模式，
   * 这里只钳制缩放范围（CSS px），窗口矩形由渲染帧逐帧跟随角色剪影。
   */
  private _applyWindowSettingsAndroid(s: PetSettings, restoreWindow: boolean): void {
    const shell = androidShell();
    if (!shell) return;
    const metrics = JSON.parse(shell.getMetrics()) as {
      screenW: number;
      screenH: number;
    };
    const baseH = 675 * PetApp._windowMarginRatio;
    const baseW =
      baseH * (this._model?.isReady() ? this._model.boundsAspect : 512 / 768);
    let scale = s.scale;
    if (metrics.screenW > 0 && metrics.screenH > 0) {
      const minS = Math.max(56 / baseW, 72 / baseH);
      const maxS = Math.max(0.5, Math.min(metrics.screenW / baseW, metrics.screenH / baseH));
      scale = Math.min(Math.max(scale, minS), maxS);
    }
    if (this._wrapWindow) {
      // 贴合模式：尺寸直接驱动内容渲染比例，画布在帧循环内跟随窗口
      this._contentScaleCss =
        (baseH * scale) / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
      if (restoreWindow && !this._originUnset()) {
        this._originCssX = s.posX as number;
        this._originCssY = s.posY as number;
      }
      this._rectInited = false; // 强制下一帧完整下发新矩形
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

  /** 设置窗口/托盘事件接线。 */
  private _wireSettingsSync(): void {
    import('@tauri-apps/api/event')
      .then((ev) => {
        // 设置窗口推送的全量设置
        ev.listen<PetSettings>('settings-changed', (e) => {
          if (!e.payload || typeof e.payload !== 'object') return;
          this.applySettings(e.payload, false);
        });
        // 托盘/设置窗口动作
        ev.listen<{
          action: string;
          value?: boolean;
          name?: string;
          duration?: number;
        }>('tray-action', (e) => {
          const p = e.payload;
          if (!p || typeof p.action !== 'string') return;
          switch (p.action) {
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
                this._playRandom();
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
        });
        // Rust 全局光标广播（物理 px）：光标不在窗口上时视线也要跟随
        ev.listen<{ x: number; y: number }>('global-mouse', (e) => {
          if (!this._behavior || this._wrapWindow) return;
          if (Number.isFinite(e.payload.x) && Number.isFinite(e.payload.y)) {
            this._globalMouse = e.payload;
          }
        });
      })
      .catch(() => {
        // 浏览器环境：无事件同步
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

  /** 向设置窗口广播当前情绪（「表情与情绪」面板高亮同步）。 */
  private _broadcastMood(name: string): void {
    if (!this._tauriWindow) return;
    import('@tauri-apps/api/event')
      .then((ev) => {
        ev.emitTo('settings', 'pet-mood', { mood: name }).catch(() => {});
      })
      .catch(() => {});
  }

  /** 位置重置：移回主屏幕中央。 */
  public resetPosition(): void {
    if (platform === 'android') {
      const shell = androidShell();
      if (!shell) return;
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
      const x = Math.max(Math.round((m.screenW - m.winW) / 2), 0);
      const y = Math.max(Math.round((m.screenH - m.winH) / 2), 0);
      shell.setWindowPos(x, y);
      this._settings.posX = x;
      this._settings.posY = y;
      saveSettings(this._settings);
      shell.setPref('petX', String(x));
      shell.setPref('petY', String(y));
      return;
    }
    const win = this._tauriWindow;
    if (!win) return;
    import('@tauri-apps/api/window')
      .then(async (m) => {
        const mon = (await m.currentMonitor()) ?? (await m.primaryMonitor());
        if (!mon) return;
        const size = await win.outerSize();
        const x = mon.workArea.position.x + Math.round((mon.workArea.size.width - size.width) / 2);
        const y =
          mon.workArea.position.y + Math.round((mon.workArea.size.height - size.height) / 2);
        await win.setPosition(new m.PhysicalPosition(x, y));
        this._winPhysX = x;
        this._winPhysY = y;
        this._settings.posX = x;
        this._settings.posY = y;
        saveSettings(this._settings);
      })
      .catch(() => {});
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

  /** 拖动结束：窗口始终允许越界；开启贴边时仅在边缘感应带内吸附，然后保存位置。 */
  private _onDragFinished(): void {
    if (platform === 'android') {
      this._onDragFinishedAndroid();
      return;
    }
    const win = this._tauriWindow;
    if (!win) return;
    const token = ++this._snapAnimToken;
    const pendingMove = this._windowMoveTask;
    import('@tauri-apps/api/window')
      .then(async (m) => {
        await pendingMove;
        if (token !== this._snapAnimToken) return;
        {
          const mon = await m.currentMonitor();
          if (mon && this._settings.snapEdges) {
            const size = await win.outerSize();
            const threshold = Math.round(32 * mon.scaleFactor);
            if (token !== this._snapAnimToken) return;
            let x = this._winPhysX;
            let y = this._winPhysY;
            const left = mon.workArea.position.x;
            const top = mon.workArea.position.y;
            const right = left + mon.workArea.size.width - size.width;
            const bottom = top + mon.workArea.size.height - size.height;
            const edges: string[] = [];
            // 允许越界：只比较对应窗口边与屏幕边的距离，不做最后 clamp。
            if (Math.abs(x - left) <= threshold) { x = left; edges.push('left'); }
            else if (Math.abs(x - right) <= threshold) { x = right; edges.push('right'); }
            if (Math.abs(y - top) <= threshold) { y = top; edges.push('top'); }
            else if (Math.abs(y - bottom) <= threshold) { y = bottom; edges.push('bottom'); }
            if (x !== this._winPhysX || y !== this._winPhysY) {
              await win.setPosition(new m.PhysicalPosition(x, y));
              this._winPhysX = x;
              this._winPhysY = y;
              this._showSnapHint(edges);
            }
          }
        }
        this._settings.posX = this._winPhysX;
        this._settings.posY = this._winPhysY;
        saveSettings(this._settings);
      })
      .catch(() => {});
  }

  /**
   * Android 拖动结束：贴边吸附（缓动归位）+ 位置持久化。
   * 不做防丢钳制：用户明确要求可以整个拖出屏幕（找不回时走设置页「重置位置」）。
   */
  private _onDragFinishedAndroid(): void {
    const shell = androidShell();
    if (!shell) return;
    // App 内全屏模式没有可移动的窗口：不吸附、不持久化
    // （曾在此把 winX/winY(=0,0) 当窗口坐标写进 posX/posY，污染悬浮窗原点）
    if (!this._wrapWindow) return;
    if (this._settings.snapEdges) {
      const m = JSON.parse(shell.getMetrics()) as {
        screenW: number;
        screenH: number;
      };
      const b = this._model?.getStaticBounds() ?? null;
      if (b && m.screenW > 0) {
        const s = this._contentScaleCss;
        const th = 32;
        let tx = this._originCssX;
        let ty = this._originCssY;
        const charL = tx + b.minX * s;
        const charR = tx + b.maxX * s;
        const charT = ty - b.maxY * s;
        const charB = ty - b.minY * s;
        if (Math.abs(charL) < th) tx -= charL;
        else if (Math.abs(charR - m.screenW) < th) tx += m.screenW - charR;
        if (Math.abs(charT) < th) ty -= charT;
        else if (Math.abs(charB - m.screenH) < th) ty += m.screenH - charB;
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

  /**
   * 吸附归位动画：easeOutCubic 缓动 ~220ms。
   * 逐帧只平移窗口（尺寸不变 → 无表面重排），滑动观感而非抽搐。
   * 新拖动/新吸附经 _snapAnimToken 自增打断。
   */
  private _animateOriginTo(tx: number, ty: number, durMs = 220): void {
    const token = ++this._snapAnimToken;
    const sx = this._originCssX;
    const sy = this._originCssY;
    const t0 = performance.now();
    const step = (): void => {
      if (token !== this._snapAnimToken) return;
      const k = Math.min(1, (performance.now() - t0) / durMs);
      const e = 1 - Math.pow(1 - k, 3);
      this._originCssX = sx + (tx - sx) * e;
      this._originCssY = sy + (ty - sy) * e;
      this._rectDirty = true; // 驱动 _syncWrapWindow 逐帧平移跟随
      if (k < 1) requestAnimationFrame(step);
      else this._persistWrapOrigin();
    };
    requestAnimationFrame(step);
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

  private _playRandom(): void {
    if (this._remoteChat.open || this._chatView?.isOpen || !this._coordination.canSpeak('ambient')) return;
    const resolved = this._dialogue.resolveRandom();
    if (resolved) this._speak(resolved, 'ambient');
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
    if (this._chatView?.isOpen && this._model?.isReady()) {
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

  /** 构造互动上下文（归一化坐标 + 物理像素 + 真实事件间隔）。 */
  private _ctx(e: PointerEvent, isSecondary: boolean): PointerContext {
    const rect = this._canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this._canvas.width / rect.width : 1;
    const now = performance.now();
    const dt =
      this._lastMoveEventMs > 0
        ? Math.min(Math.max((now - this._lastMoveEventMs) / 1000, 0.001), 0.2)
        : 0.016;
    this._lastMoveEventMs = now;
    const n = this._eventNorm(e);
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
      if (!e.isPrimary || (e.button !== 0 && e.button !== 2)) return;
      this._coordination.activity();
      this._snapAnimToken++;
      // 透明像素兜底：壳穿透生效前的竞态，落在透明区的事件不触发互动
      if (
        platform === 'tauri' &&
        this._hitMaskData.length > 0 &&
        !this._isOpaqueAt(e)
      ) {
        return;
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // 合成事件/非常规指针没有 active pointer，捕获失败不影响交互
      }
      const n0 = this._eventNorm(e);
      const isSecondary =
        e.button === 2 ||
        // 触摸端没有右键：按下头部抚摸区视为抚摸手势起点，
        // 其余区域的单指按住保留给拖动窗口
        (isTouchDevice &&
          e.button === 0 &&
          this._hitAreas.isInHeadPetZone(n0.nx, n0.ny));
      const ctx = this._ctx(e, isSecondary);
      this._touchPetting = isTouchDevice && isSecondary && e.button === 0;
      this._touchTapCandidate = this._touchPetting;
      this._downScreenX = e.screenX;
      this._downScreenY = e.screenY;
      // 视线跟随：按下即更新目标（轻点不移动也要看向触点）
      if (platform !== 'tauri' || e.pointerType !== 'mouse') {
        this._behavior?.updateLookTarget(ctx.normX, ctx.normY);
      }

      if (isSecondary) {
        // 右键/触摸头部：只走抚摸，永不触发拖动/点击
        // 声明互动手势：悬浮窗壳不得把这次手势抢成拖动
        if (this._wrapWindow) androidShell()?.setInteracting(true);
        this._interaction?.onPointerDown(ctx);
        return;
      }
      if (e.button !== 0) return;

      this._leftDown = true;
      if (platform !== 'tauri' || e.pointerType !== 'mouse') {
        this._behavior?.updateLookTarget(ctx.normX, ctx.normY);
      }
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
      if (!e.isPrimary) return;
      if (this._touchPetting && Math.hypot(e.screenX - this._downScreenX, e.screenY - this._downScreenY) >= PetApp._dragThresholdPx) {
        this._touchTapCandidate = false;
      }
      const ctx = this._ctx(e, (e.buttons & 2) !== 0);
      const handled = this._interaction?.onPointerMove(ctx) ?? false;
      if (platform !== 'tauri' || e.pointerType !== 'mouse') {
        this._behavior?.updateLookTarget(ctx.normX, ctx.normY);
      }

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
      if (!e.isPrimary) return;
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
    });

    canvas.addEventListener('pointercancel', () => {
      // 触摸流被系统/下层窗口截断：按拖动结束处理（保存位置 + 吸附）
      // （贴合模式拖动由壳接管，壳在 UP/CANCEL 回传总位移，这里不重复收尾）
      if (this._dragging && !this._wrapWindow) this._onDragFinished();
      this._cancelInteraction();
      if (this._wrapWindow) androidShell()?.setInteracting(false);
      this._resetDragState();
    });
    canvas.addEventListener('lostpointercapture', () => {
      if (!this._leftDown && !this._touchPetting &&
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
    this._touchPetting = false;
    this._interaction?.cancel();
    this._coordination.activity();
  }

  /** 拉取窗口物理位置与 DPI 缩放（拖动增量换算用）。 */
  private _syncWindowMetrics(): void {
    const win = this._tauriWindow;
    if (!win) return;
    Promise.all([win.outerPosition(), win.scaleFactor()])
      .then(([pos, sf]) => {
        this._scaleFactor = sf;
        this._metricsSynced = true;
        if (!this._dragging && !this._windowMoveTask) {
          this._winPhysX = pos.x;
          this._winPhysY = pos.y;
          this._syncChatAnchor();
        }
      })
      .catch(() => {
        // 忽略：保持上次值
      });
  }

  /**
   * 向壳上报 Live2D 实际可见矩形（物理像素），不是包含大量透明留白的 pet 外窗。
   * 非贴合模式与渲染矩阵同口径：包围盒按画布容纳后居中；chat 据此贴到模型下半部。
   */
  private _syncChatAnchor(): void {
    if (platform !== 'tauri' || !this._metricsSynced) return;
    const rect = this._canvas.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    let w = rect.width || window.innerWidth;
    let h = rect.height || window.innerHeight;
    if (this._model?.isReady() && w > 0 && h > 0) {
      const fitH = Math.min(h, w / this._model.boundsAspect);
      const fitW = fitH * this._model.boundsAspect;
      left += (w - fitW) / 2;
      top += (h - fitH) / 2;
      w = fitW;
      h = fitH;
    }
    const sf = this._scaleFactor;
    void import('@tauri-apps/api/core')
      .then(m => m.invoke('sync_chat_anchor', {
        x: Math.round(this._winPhysX + left * sf),
        y: Math.round(this._winPhysY + top * sf),
        w: Math.round(w * sf),
        h: Math.round(h * sf),
      }))
      .catch(() => {});
  }

  /** 按 CSS 像素增量移动窗口（内部换算物理像素）。 */
  private _moveWindowBy(deltaCssX: number, deltaCssY: number): void {
    if (platform === 'android') {
      // 壳侧同步应用增量（乘 density），无缓存竞态问题
      androidShell()?.moveWindowBy(deltaCssX, deltaCssY);
      return;
    }
    const win = this._tauriWindow;
    if (!win || !this._metricsSynced) return;
    this._winPhysX += Math.round(deltaCssX * this._scaleFactor);
    this._winPhysY += Math.round(deltaCssY * this._scaleFactor);
    if (this._windowMoveTask) return;
    this._windowMoveTask = import('@tauri-apps/api/window')
      .then(async (m) => {
        // 串行提交并合并期间新增的位移，防止 IPC 回包乱序把窗口拉回旧位置。
        let x: number, y: number;
        do {
          x = this._winPhysX;
          y = this._winPhysY;
          await win.setPosition(new m.PhysicalPosition(x, y));
        } while (x !== this._winPhysX || y !== this._winPhysY);
      })
      .catch(() => {
        this._windowMoveTask = null;
        this._syncWindowMetrics();
      })
      .finally(() => {
        this._windowMoveTask = null;
      });
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
    }
    if (!paused && this._running) {
      this._lastFrameTime = performance.now();
      requestAnimationFrame((t) => this._frame(t));
    }
  }

  /** 壳事件入口（Android 壳经 evaluateJavascript 调用）。 */
  public onShellEvent(event: string): void {
    if (event === 'screen-off' || event === 'pause') this.setPaused(true);
    else if (event === 'screen-on' || event === 'resume') this.setPaused(false);
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
    this._snapAnimToken++; // 新拖动打断吸附归位动画
    this._leftDown = false;
    this._dragCandidate = false;
    this._dragging = false;
    // 壳在 MOVE 超阈值时抢走手势，DOWN 已透传给 WebView——
    // 壳侧会先补发 ACTION_CANCEL（触发 pointercancel 收尾），这里兜底再清一次：
    // 抚摸按下态不残留，jsInteracting 也复位（否则后续拖动被壳的 !jsInteracting 拦截）
    this._cancelInteraction();
    androidShell()?.setInteracting(false);
    if (this._behavior) this._behavior.isDragging = true;
  }

  /**
   * 悬浮窗原生拖动结束：壳回传全程位移（CSS px）。
   * 原点/已应用矩形同步平移（渲染锚定不变），随后吸附归位（缓动）+ 持久化。
   */
  public onNativeDragEnd(dxCss: number, dyCss: number): void {
    this._coordination.activity();
    this._nativeDragging = false;
    this._snapAnimToken++; // 打断进行中的吸附动画
    this._originCssX += dxCss;
    this._originCssY += dyCss;
    this._appliedRectX += dxCss;
    this._appliedRectY += dyCss;
    if (this._behavior) this._behavior.isDragging = false;
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
    // 贴合模式先下发窗口矩形（渲染矩阵使用同一套矩形，变化有一帧过渡）
    if (this._wrapWindow) this._syncWrapWindow();
    this._render();
    this._positionBubble();
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
      const fitH = this._chatView?.isOpen ? Math.min(vpH, vpW / this._model.boundsAspect) : vpH;
      const s = fitH / PetApp._renderMarginRatio / (this._model?.boundsH ?? 1);
      headTopCss = vpH / 2 - b.maxY * s;
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

  private _update(dt: number): void {
    // 互动层先算平滑值并写入模型通道，模型 update 时统一应用
    this._chatPerformance?.tick();
    this._interaction?.tick(dt * 1000);
    this._moodEngine?.tick(dt);
    this._model?.update(dt);
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
    if (this._wrapWindow) {
      // 贴合模式：渲染比例固定，模型原点锚在窗口内对应位置，窗口包裹剪影。
      const sDev = this._contentScaleCss * this._dpr;
      modelMatrix.scale(sDev, -sDev); // 模型 Y 轴朝上，视口 Y 轴朝下
      modelMatrix.translate(
        (this._originCssX - this._appliedRectX) * this._dpr,
        (this._originCssY - this._appliedRectY) * this._dpr
      );
    } else {
      // 视口适配算法与 native SetupModelMatrix/Render 一致：
      //   模型渲染高 = 视口高 / 余量，按包围盒均匀缩放，模型原点置于视口中心。
      // 官方 Demo 的 canvas-fit 对 Aliya 的 1×1 方形画布会把角色缩到窗口的 ~44%，
      // 观感与 Flutter 版不符（"压扁"）；包围盒适配才是用户熟悉的布局。
      const fitH = this._chatView?.isOpen ? Math.min(vpH, vpW / this._model.boundsAspect) : vpH;
      const s = fitH / PetApp._renderMarginRatio / this._model.boundsH;
      modelMatrix.scale(s, -s); // 模型 Y 轴朝上，视口 Y 轴朝下
      modelMatrix.translate(vpW * 0.5, vpH * 0.5);
    }

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
    const s = this._contentScaleCss;
    const band = PetApp._WRAP_BUBBLE_BAND;
    const b = this._model?.getStaticBounds() ?? null;
    const baseH = 675 * PetApp._windowMarginRatio * this._settings.scale;
    const baseW =
      baseH * (this._model?.isReady() ? this._model.boundsAspect : 512 / 768);
    // 静态剪影中心的屏幕坐标（模型 Y 轴朝上 → 屏幕坐标减）
    const ccx = this._originCssX + (b ? ((b.minX + b.maxX) / 2) * s : 0);
    const ccy = this._originCssY - (b ? ((b.minY + b.maxY) / 2) * s : 0);
    return {
      x: ccx - baseW / 2,
      y: ccy - baseH / 2 - band,
      w: baseW,
      h: baseH + band,
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
    const interacting = this._leftDown || this._touchPetting || (this._chatView?.pointerActive ?? false);
    const now = performance.now();
    if (
      now - this._hitMaskLastMs < 120 &&
      interacting === this._hitMaskInteracting
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
    const img = ctx.getImageData(0, 0, cols, rows).data;
    const data = new Uint8Array(cols * rows);
    for (let i = 0; i < data.length; i++) {
      data[i] = img[i * 4 + 3] > PetApp._hitMaskAlphaThreshold ? 1 : 0;
    }
    if (
      interacting === this._hitMaskInteracting &&
      data.length === this._hitMaskData.length &&
      rows === this._hitMaskRows &&
      data.every((v, i) => v === this._hitMaskData[i])
    ) {
      return; // 掩码无变化：寂静期零 IPC
    }
    this._hitMaskData = data;
    this._hitMaskRows = rows;
    this._hitMaskInteracting = interacting;
    if (androidWrap) {
      // Android 悬浮窗：壳在 ACTION_DOWN 命中透明格时临时切 NOT_TOUCHABLE 穿透
      let csv = '';
      for (let i = 0; i < data.length; i++) csv += data[i];
      androidShell()?.setHitMask(cols, rows, csv);
      return;
    }
    this._hitMaskSend?.({
      cols,
      rows,
      data: Array.from(data),
      interacting,
      winX: this._winPhysX,
      winY: this._winPhysY,
      winW: Math.round(window.innerWidth * this._scaleFactor),
      winH: Math.round(window.innerHeight * this._scaleFactor),
    });
  }

  /** 事件位置是否落在角色不透明像素上（壳穿透生效前的竞态兜底）。 */
  private _isOpaqueAt(e: PointerEvent): boolean {
    if (this._hitMaskData.length === 0 || this._hitMaskRows === 0) return true;
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return true;
    const cols = PetApp._hitMaskCols;
    const gx = Math.min(
      cols - 1,
      Math.max(0, Math.floor((e.clientX / Math.max(1, window.innerWidth)) * cols))
    );
    const gy = Math.min(
      this._hitMaskRows - 1,
      Math.max(0, Math.floor((e.clientY / Math.max(1, window.innerHeight)) * this._hitMaskRows))
    );
    return this._hitMaskData[gy * cols + gx] !== 0;
  }
}
