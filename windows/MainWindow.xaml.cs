using System.IO;
using System.Globalization;
using System.Text.Json;
using System.Net.Http;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using System.Windows.Interop;
using AliyaPet.Models.Dialogue;
using AliyaPet.Rendering;
using AliyaPet.Services.Dialogue;
using AliyaPet.Services.Mouth;
using AliyaPet.Services.Interaction;
using AliyaPet.Models.Interaction;
using Windows.Devices.Geolocation;

namespace AliyaPet;

public partial class MainWindow : Window, IDialogueDisplay, IPettingDialogueHost
{
    private const double DragThreshold = 5;
    private const double EdgeSnapThreshold = 160;
    private const double HorizontalAnimationPadding = 70;
    private const double TopAnimationPaddingDelta = 50;
    private const double VerticalAnimationPadding = 120;
    private const double MinimumVisualWidth = 140;
    private const double MaximumVisualWidth = 600;
    private const double VersionOneBottomExpansion = 58;
    private const int CurrentLayoutVersion = 2;
    private const int BlinkFrameCount = 3;
    private const int BlinkFrameDurationMilliseconds = 50;
    private const int DefaultRandomSpeechIntervalMinutes = 15;
    private const string AliyaCharacter = "Aliya";
    private const string WindyCharacter = "Windy";
    private const string UserClickScene = "user_click";
    /// <summary>自定义抚摸指针开关：当前禁用（只显示普通 Windows 鼠标，不显示任何手掌/抚摸覆盖图标）。</summary>
    private static readonly bool UseCustomPettingCursor = false;
    private readonly DispatcherTimer _idleTimer;
    private readonly DispatcherTimer _speechTimer;
    private readonly DispatcherTimer _randomSpeechTimer;
    private readonly DispatcherTimer _greetingTimer;
    private readonly DispatcherTimer _hoverHideTimer;
    private readonly DispatcherTimer _autoActionTimer;
    private readonly DispatcherTimer _blinkTimer;
    private readonly DispatcherTimer _openEyesTimer;
    private readonly Random _random = new();
    private readonly MediaPlayer _touchSoundPlayer = new();
    private static readonly HttpClient WeatherClient = new()
    {
        Timeout = TimeSpan.FromSeconds(10)
    };
    private readonly string _settingsDirectory;
    private readonly string _settingsPath;
    private readonly string _defaultTouchSoundPath;

    private bool _dragging;
    private bool _pointerMoved;
    private bool _actionRunning;
    private bool _autoActions = true;
    private bool _petRunning = true;
    private bool _snapToEdge = true;
    private bool _timeGreetingEnabled = true;
    private bool _mealReminderEnabled = true;
    private bool _nightRestReminderEnabled = true;
    private bool _weatherGreetingEnabled;
    private bool _randomSpeechEnabled;
    private bool _touchSoundEnabled = true;
    private string _touchSoundSource = "default";
    private string? _customTouchSoundPath;
    private double _touchSoundVolume = 0.35;
    private int _randomSpeechIntervalMinutes = DefaultRandomSpeechIntervalMinutes;
    private int _blinkFramesRemaining;
    private string _character = AliyaCharacter;
    private Point _mouseStart;
    private Point _lastMouse;
    private DpiScale _dragDpi = new(1, 1);
    private double _leftStart;
    private double _topStart;
    private double _phase;
    private string _lastGreetingKey = "";
    private string _lastWeatherGreetingDate = "";
    private string? _weatherGreeting;
    private DateTime _weatherUpdatedAt;

    // ---- 台词与嘴型服务 ----
    private DialogueRepository _dialogueRepository = null!;
    private TimeSceneService _timeSceneService = null!;
    private DialogueVariableService _dialogueVariables = null!;
    private DialogueSelectionService _dialogueSelection = null!;
    private DialoguePaginationService _dialoguePagination = null!;
    private DialoguePlaybackService _dialoguePlayback = null!;
    private PinyinMouthMapper _pinyinMapper = null!;
    private TextMouthTimelineBuilder _mouthTimelineBuilder = null!;
    private Live2DMouthController _mouthController = null!;
    private MouthAnimationRunner _mouthRunner = null!;
    private CancellationTokenSource? _dialogueCts;

    // ---- 人物互动 ----
    private InteractionService _interaction = null!;
    private double _palmRotateCurrent;
    private DispatcherTimer? _pettingSafetyTimer;

    private sealed class PetSettings
    {
        public PetSettings() { }

        public int LayoutVersion { get; set; }
        public double Left { get; set; } = double.NaN;
        public double Top { get; set; } = double.NaN;
        public double Width { get; set; } = 300;
        public double Height { get; set; } = 470;
        public bool Topmost { get; set; } = true;
        public bool PetRunning { get; set; } = true;
        public bool AutoActions { get; set; } = true;
        public bool SnapToEdge { get; set; } = true;
        public bool TimeGreetingEnabled { get; set; } = true;
        public bool MealReminderEnabled { get; set; } = true;
        public bool NightRestReminderEnabled { get; set; } = true;
        public bool WeatherGreetingEnabled { get; set; }
        public bool RandomSpeechEnabled { get; set; }
        public int RandomSpeechIntervalMinutes { get; set; } =
            DefaultRandomSpeechIntervalMinutes;
        public string Character { get; set; } = AliyaCharacter;
        public bool TouchSoundEnabled { get; set; } = true;
        public string TouchSoundSource { get; set; } = "default";
        public string? CustomTouchSoundPath { get; set; }
        public double TouchSoundVolume { get; set; } = 0.35;
        public string CharacterRendererMode { get; set; } = "existing";
        public bool Live2DLookAtEnabled { get; set; } = true;
        public string GazeFollowMode { get; set; } = "nearby";
public double GazeSpeedMultiplier { get; set; } = 1.0;        public double PhysicsStrength { get; set; } = 1.0;
        public double Live2DPhysicsOutputAmplitude { get; set; } = 1.0; // Physics 输出幅度倍率（0.0~2.0，旧配置缺省 1.0）
        public double GazeIdleTimeoutSeconds { get; set; } = 5.0;
        public double Live2DGazeHeadFollowAmount { get; set; } = 0.9; // 头部跟随幅度（0.2~1.0，默认 0.9）
        public string LastGreetingKey { get; set; } = "";
        public string LastWeatherGreetingDate { get; set; } = "";
    }

    public MainWindow()
    {
        InitializeComponent();

        _settingsDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AliyaDesktopPet");
        Directory.CreateDirectory(_settingsDirectory);
        _settingsPath = Path.Combine(_settingsDirectory, "settings.json");
        _defaultTouchSoundPath = Path.Combine(
            AppContext.BaseDirectory,
            "Assets",
            "pet_touch.wav");
        InitializeDialogueServices();
        Loaded += MainWindow_Loaded;
        Closing += (_, _) =>
        {
            _interaction.OnWindowClosed();
            CancelDialogue("app_closing");
            _mouthRunner?.StopNow();
            SaveSettings();
            _touchSoundPlayer.Close();
            DisposeLive2DForExit();
        };

        _idleTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        _idleTimer.Tick += (_, _) => UpdateIdleAnimation();

        _speechTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3.2) };
        _speechTimer.Tick += (_, _) =>
        {
            SpeechBubble.Visibility = Visibility.Collapsed;
            _speechTimer.Stop();
        };

        _randomSpeechTimer = new DispatcherTimer();
        _randomSpeechTimer.Tick += (_, _) =>
        {
            _randomSpeechTimer.Stop();
            if (_petRunning && _randomSpeechEnabled && !_dragging && !_actionRunning)
                PlayDialogueRandom();
            ScheduleNextRandomSpeech();
        };

        _greetingTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _greetingTimer.Tick += async (_, _) => await CheckScheduledGreetingAsync();

        _hoverHideTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ToolbarHideDelayMilliseconds) };
        _hoverHideTimer.Tick += (_, _) =>
        {
            _hoverHideTimer.Stop();
            // 只有倒计时结束且鼠标不在任何相关区域时才隐藏工具栏
            if (!IsPointerInsideToolbarInteractionRegion() && !IsToolbarPinned())
                HideQuickActions();
        };

        _openEyesTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(BlinkFrameDurationMilliseconds)
        };
        _openEyesTimer.Tick += (_, _) =>
        {
            _blinkFramesRemaining--;
            if (_blinkFramesRemaining > 0)
            {
                SetPetImage(true);
                return;
            }

            _openEyesTimer.Stop();
            SetPetImage(false);
            ScheduleNextBlink();
        };

        _blinkTimer = new DispatcherTimer();
        _blinkTimer.Tick += (_, _) =>
        {
            _blinkTimer.Stop();
            if (_dragging)
            {
                ScheduleNextBlink();
                return;
            }

            SetPetImage(true);
            _blinkFramesRemaining = BlinkFrameCount;
            _openEyesTimer.Start();
        };

        _autoActionTimer = new DispatcherTimer();
        _autoActionTimer.Tick += async (_, _) =>
        {
            _autoActionTimer.Stop();
            if (_petRunning && _autoActions && !_dragging && !_actionRunning)
                await PlayRandomActionAsync(false);
            ScheduleNextAutoAction();
        };
        InitializeLive2D();

        // 抚摸输入消费计时器：高频 MouseMove 只记录最新快照，此计时器按输入采样率（30/60Hz）
        // 每帧最多消费一次最新输入，交由现有 InteractionService 处理（识别/反应/光标/容错区）。
        // 只在抚摸模式激活时启动（OnPettingModeChanged）。
        _pettingInputTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000.0 / _pettingInputRateHz) };
        _pettingInputTimer.Tick += (_, _) => ConsumePettingInput();

        // 抚摸热路径性能诊断（PETTING_PERF 每 5 秒汇总）
        PettingPerfDiagnostics.Initialize();
    }

    /// <summary>初始化台词与嘴型服务（相对路径加载 Assets/dialogue 全部 JSON）。</summary>
    private void InitializeDialogueServices()
    {
        _timeSceneService = new TimeSceneService();

        _dialogueRepository = new DialogueRepository();
        _dialogueRepository.LoadFromDirectory(Path.Combine(
            AppContext.BaseDirectory, "Assets", "dialogue"));

        _dialogueVariables = new DialogueVariableService(_timeSceneService);
        _dialogueSelection = new DialogueSelectionService(_dialogueRepository);
        _dialoguePagination = new DialoguePaginationService();

        _pinyinMapper = new PinyinMouthMapper();
        _mouthTimelineBuilder = new TextMouthTimelineBuilder(_pinyinMapper);
        _mouthController = new Live2DMouthController(() => _live2D);
        _mouthRunner = new MouthAnimationRunner(_mouthController);

        _dialoguePlayback = new DialoguePlaybackService(
            _dialogueRepository,
            _dialogueSelection,
            _dialogueVariables,
            _dialoguePagination,
            _mouthTimelineBuilder,
            _mouthRunner,
            this);

        InitializeInteractionServices();
    }

    /// <summary>初始化人物互动服务（区域识别/手势/台词与参数动画统一入口）。</summary>
    private void InitializeInteractionServices()
    {
        var hitArea = new HitAreaService();
        var clickSequence = new ClickSequenceService();
        var proximity = new PointerProximityService();
        var longPress = new LongPressService();
        var dragReaction = new DragReactionService();
        var stateService = new InteractionStateService();
        var recognizer = new PettingGestureRecognizer();
        var reaction = new PettingReactionController(() => _live2D);
        var procedural = new ProceduralReactionService(
            () => _live2D,
            () => _interaction is not null && _interaction.IsPettingModeActive,
            PlayCharacterAction);
        var headPetting = new HeadPettingService(
            hitArea, recognizer, reaction, stateService, _dialoguePlayback, this);

        _interaction = new InteractionService(
            hitArea, clickSequence, proximity, longPress, dragReaction, headPetting, reaction, procedural, stateService);

        _interaction.PlayClickDialogue = () => PlayDialogue(UserClickScene);
        _interaction.IsDialogueActive = () => _dialogueCts is not null;
        _interaction.PettingModeChanged += OnPettingModeChanged;
        _interaction.Initialize(Path.Combine(AppContext.BaseDirectory, "Assets"));

        // 抚摸会话结束统一处理：释放人物层捕获 + 更新光标
        headPetting.SessionEnded += _ =>
        {
            if (Mouse.Captured is not null
                && (ReferenceEquals(Mouse.Captured, PetImage) || ReferenceEquals(Mouse.Captured, Live2DImage)))
            {
                Mouse.Capture(null);
            }
            ApplyPettingCursorByState();
        };

        // 窗口失焦 / Alt+Tab：结束抚摸会话，防止永久闭眼
        Deactivated += (_, _) =>
            headPetting.EndPettingSession(PettingEndReason.WindowDeactivated);

        // 鼠标捕获丢失（系统夺走 / 异常）：自动恢复
        PetImage.LostMouseCapture += (_, _) =>
            headPetting.EndPettingSession(PettingEndReason.LostCapture);
        Live2DImage.LostMouseCapture += (_, _) =>
            headPetting.EndPettingSession(PettingEndReason.LostCapture);

        // 安全兜底：低频检查左键已松开/捕获丢失/窗口失活/无手势样本超时，避免永久闭眼
        _pettingSafetyTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(150) };
        _pettingSafetyTimer.Tick += (_, _) => CheckPettingSafety();
        _pettingSafetyTimer.Start();

        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
                _interaction.OnEsc();
        };

        // 加载并缓存抚摸模式光标（HeadPettingGrabbing.cur，Bibata 中等档）
        LoadHeadPettingCursor();
    }

    /// <summary>取消当前台词会话（再次点击/新时间问候/切换角色/重载 Live2D/关闭时调用）。</summary>
    private void CancelDialogue(string reason)
    {
        if (_dialogueCts is not null)
        {
            AppLog.Info("PLAYBACK_CANCEL reason={0}", reason);
            _dialogueCts.Cancel();
        }
        _mouthRunner?.StopNow();
    }

    private async void PlayDialogue(string scene)
    {
        CancelDialogue("new_session:" + scene);
        var cts = new CancellationTokenSource();
        _dialogueCts = cts;
        try
        {
            var resolved = _dialoguePlayback.ResolveScene(scene);
            if (resolved is not null)
                await _dialoguePlayback.PlayAsync(resolved, cts.Token);
        }
        catch (Exception ex)
        {
            AppLog.Error("DIALOGUE_PLAY_START_FAILED scene={0} error={1}", scene, ex.Message);
        }
        finally
        {
            if (ReferenceEquals(_dialogueCts, cts))
            {
                _dialogueCts = null;
                cts.Dispose();
            }
        }
    }

    private async void PlayDialogueRandom()
    {
        CancelDialogue("new_session:random");
        var cts = new CancellationTokenSource();
        _dialogueCts = cts;
        try
        {
            var resolved = _dialoguePlayback.ResolveRandom();
            if (resolved is not null)
                await _dialoguePlayback.PlayAsync(resolved, cts.Token);
        }
        catch (Exception ex)
        {
            AppLog.Error("DIALOGUE_PLAY_RANDOM_FAILED error={0}", ex.Message);
        }
        finally
        {
            if (ReferenceEquals(_dialogueCts, cts))
            {
                _dialogueCts = null;
                cts.Dispose();
            }
        }
    }

    /// <summary>气泡显示实现（供 DialoguePlaybackService 调用）。</summary>
    private void ShowSpeechPage(string pageText)
    {
        _speechTimer.Stop();
        SpeechText.Text = pageText;
        SpeechBubble.Visibility = Visibility.Visible;
    }

    private void HideSpeechBubble()
    {
        _speechTimer.Stop();
        SpeechBubble.Visibility = Visibility.Collapsed;
    }

    // ---- IDialogueDisplay ----
    void IDialogueDisplay.ShowPage(string pageText) => ShowSpeechPage(pageText);

    void IDialogueDisplay.HideBubble() => HideSpeechBubble();

    // ---- IPettingDialogueHost ----
    bool IPettingDialogueHost.IsDialogueActive => _dialogueCts is not null;

    void IPettingDialogueHost.PlayPettingDialogue(ResolvedDialogue resolved)
    {
        if (resolved is null)
            return;
        CancelDialogue("petting_dialogue");
        var cts = new CancellationTokenSource();
        _dialogueCts = cts;
        _ = PlayResolvedAsync(resolved, cts);
    }

    private async Task PlayResolvedAsync(ResolvedDialogue resolved, CancellationTokenSource cts)
    {
        try
        {
            await _dialoguePlayback.PlayAsync(resolved, cts.Token);
        }
        catch (Exception ex)
        {
            AppLog.Error("DIALOGUE_PLAY_RESOLVED_FAILED id={0} error={1}", resolved.Entry.Id, ex.Message);
        }
        finally
        {
            if (ReferenceEquals(_dialogueCts, cts))
            {
                _dialogueCts = null;
                cts.Dispose();
            }
        }
    }

    // ---- 抚摸模式 UI ----
    private void HeadPettingButton_Click(object sender, RoutedEventArgs e)
    {
        _interaction.TogglePettingMode();
        e.Handled = true;
    }

    private void OnPettingModeChanged(bool active)
    {
        HeadPettingButton.IsChecked = active;
        HeadPettingButton.ToolTip = active ? "退出抚摸模式" : "进入头部抚摸模式";
        // 无论进入还是退出：彻底隐藏自定义覆盖层，并清理旧位置/旋转/缩放
        ResetPettingCursorOverlay();
        _cursorGrabbedInitialized = false; // 模式变化后光标必须重新建立
        ApplyPettingCursorState(active);

        if (active)
        {
            // 进入抚摸：刷新几何缓存并启动消费计时器（高频输入由它统一消费）。
            // 把进入模式前的旧快照标记为已消费，只处理进入后的真实 MouseMove（避免陈旧位置误判容错区结束）。
            UpdateCachedPettingGeometry();
            _lastConsumedPettingSequence = _latestPettingPointerSequence;
            _lastConsumedPointerTick = 0;
            _pettingInputTimer.Start();
        }
        else
        {
            _pettingInputTimer.Stop();
        }
    }

    /// <summary>清理自定义覆盖层位置与变换（当前禁用，但确保不残留上一次抚摸的坐标/旋转/缩放）。</summary>
    private void ResetPettingCursorOverlay()
    {
        PettingPalmCursor.Visibility = Visibility.Collapsed;
        PettingPalmCursor.Opacity = 0;
        Canvas.SetLeft(PettingPalmCursor, 0);
        Canvas.SetTop(PettingPalmCursor, 0);
        PettingPalmRotate.Angle = 0;
        PettingPalmScale.ScaleX = 1;
        PettingPalmScale.ScaleY = 1;
        _palmRotateCurrent = 0;
    }

    /// <summary>
    /// 抚摸模式指针：使用本地小尺寸（32×32）CUR 光标。
    ///   抚摸模式关闭 → 原系统光标；
    ///   开启未按下   → HeadPettingOpenHand.cur（张开手掌）；
    ///   按下抚摸中   → HeadPettingGrabbing.cur（握拳）；
    ///   工具栏区域   → Cursors.Arrow。
    /// 不显示 PettingPalmCursor（保持 Collapsed）；不按 DpiScale 手动放大（系统光标负责缩放）。
    /// </summary>
    private void ApplyPettingCursorState(bool active)
    {
        PettingPalmCursor.Visibility = Visibility.Collapsed;
        if (active)
        {
            PetImage.Cursor = _headPettingCursor ?? Cursors.Hand;
            Live2DImage.Cursor = _headPettingCursor ?? Cursors.Hand;
        }
        else
        {
            PetImage.Cursor = Cursors.Hand;
            Live2DImage.Cursor = Cursors.Hand;
        }
    }

    /// <summary>按抚摸状态切换光标：按下/抚摸中 → Grabbing（握拳）；否则 → OpenHand（张开手掌）。
    /// 仅在按下/松开状态变化时重新赋值 Cursor（内部缓存），不随每个 MouseMove 重复赋值。</summary>
    private void ApplyPettingCursorByState()
    {
        if (!_interaction.IsPettingModeActive)
            return;
        bool pressed = _interaction.HeadPetting.State is PettingState.Pressed or PettingState.Petting;
        if (_cursorGrabbedInitialized && pressed == _lastPettingCursorGrabbed)
            return; // 状态未变化，不重复赋值 Cursor
        _cursorGrabbedInitialized = true;
        _lastPettingCursorGrabbed = pressed;
        var cur = pressed
            ? (_headPettingGrabbingCursor ?? _headPettingCursor ?? Cursors.Hand)
            : (_headPettingCursor ?? Cursors.Hand);
        PetImage.Cursor = cur;
        Live2DImage.Cursor = cur;
    }

    /// <summary>加载并缓存抚摸模式光标（HeadPettingOpenHand.cur 张开手掌 + HeadPettingGrabbing.cur 握拳）。
    /// 失败回退 Cursors.Hand，不影响抚摸状态机。</summary>
    private void LoadHeadPettingCursor()
    {
        if (_headPettingCursorLoadAttempted)
            return;
        _headPettingCursorLoadAttempted = true;
        try
        {
            var dir = Path.Combine(AppContext.BaseDirectory, "Assets", "interaction", "Cursors");
            var openPath = Path.Combine(dir, "HeadPettingOpenHand.cur");
            var grabPath = Path.Combine(dir, "HeadPettingGrabbing.cur");
            if (File.Exists(openPath))
            {
                // WPF Cursor 从 .cur 文件路径创建（内部 LoadCursorFromFile，不依赖流生命周期）
                _headPettingCursor = new Cursor(openPath);
                AppLog.Info("HEAD_PETTING_CURSOR_LOADED path={0}", openPath);
            }
            else
            {
                AppLog.Warn("HEAD_PETTING_CURSOR_MISSING path={0} 回退 Cursors.Hand", openPath);
            }
            if (File.Exists(grabPath))
            {
                _headPettingGrabbingCursor = new Cursor(grabPath);
                AppLog.Info("HEAD_PETTING_GRAB_CURSOR_LOADED path={0}", grabPath);
            }
            else
            {
                AppLog.Warn("HEAD_PETTING_GRAB_CURSOR_MISSING path={0} 回退张开手掌", grabPath);
            }
        }
        catch (Exception ex)
        {
            _headPettingCursor = null;
            _headPettingGrabbingCursor = null;
            AppLog.Warn("HEAD_PETTING_CURSOR_LOAD_FAILED error={0} 回退 Cursors.Hand", ex.Message);
        }
    }

    private Cursor? _headPettingCursor;           // 张开手掌（未按下）
    private Cursor? _headPettingGrabbingCursor;   // 握拳（按下抚摸中）
    private bool _headPettingCursorLoadAttempted;

    /// <summary>安全兜底：低频检查左键已松开 / 捕获丢失 / 窗口失活 / 无手势样本超时，防止任何异常路径永久闭眼。</summary>
    private void CheckPettingSafety()
    {
        var hp = _interaction.HeadPetting;
        if (hp.State is not (PettingState.Pressed or PettingState.Petting))
            return;

        bool buttonReleased = Mouse.LeftButton != MouseButtonState.Pressed;
        bool capturedLost = Mouse.Captured is null
                            || (!ReferenceEquals(Mouse.Captured, PetImage) && !ReferenceEquals(Mouse.Captured, Live2DImage));
        bool windowInactive = !IsActive;
        if (buttonReleased || capturedLost || windowInactive)
        {
            hp.EndPettingSession(PettingEndReason.LostCapture);
            return;
        }

        // 无有效手势样本超过 1s 且指针已不在容错区 → 自动结束
        if (hp.LastActiveGestureUtc is { } last
            && (DateTime.UtcNow - last).TotalMilliseconds > 1000
            && !IsPointInPettingTolerance(Mouse.GetPosition(this)))
        {
            hp.EndPettingSession(PettingEndReason.SafetyTimeout);
        }
    }

    /// <summary>判断指针是否仍在头部抚摸容错区（headPetZone + 四周扩展 32/28 DIP，窗口 DIP 坐标）。
    /// 使用布局时预计算的缓存矩形（O(1)，不读 VisualTree/不 LINQ 查找区域）。</summary>
    private bool IsPointInPettingTolerance(Point windowPoint)
        => _cachedGeometryValid && _cachedPetToleranceRect.Contains(windowPoint);

    /// <summary>抚摸中指针移出容错区域 → 立即结束并睁眼恢复（按住左键移出后不得永久闭眼）。</summary>
    private void CheckPettingToleranceExit(Point windowPoint)
    {
        if (!_interaction.HeadPetting.IsPettingSessionActive)
            return;
        if (!IsPointInPettingTolerance(windowPoint))
            _interaction.HeadPetting.EndPettingSession(PettingEndReason.PointerOutsideTolerance);
    }

    /// <summary>抚摸模式下更新手掌指针位置/旋转/按压缩放。当前覆盖层禁用：不更新任何坐标。</summary>
    private void UpdatePalmCursor(Point windowPos, bool leftPressed)
    {
        if (!UseCustomPettingCursor)
            return;
        if (!_interaction.IsPettingModeActive)
            return;
        if (PettingPalmCursor.Visibility != Visibility.Visible)
            return;

        // 热点位于掌心/手掌下部：图标偏左上偏移
        Canvas.SetLeft(PettingPalmShape, windowPos.X - 20);
        Canvas.SetTop(PettingPalmShape, windowPos.Y - 27);

        // 左右移动旋转（-10°~10°），平滑过渡
        double targetAngle = Math.Clamp(_interaction.SmoothedVelocityXPxPerSec * 0.02, -10, 10);
        _palmRotateCurrent += (targetAngle - _palmRotateCurrent) * 0.35;
        PettingPalmRotate.Angle = _palmRotateCurrent;

        // 按下轻微缩小
        double targetScale = leftPressed ? 0.90 : 1.0;
        double cur = PettingPalmScale.ScaleX;
        double next = cur + (targetScale - cur) * 0.4;
        PettingPalmScale.ScaleX = next;
        PettingPalmScale.ScaleY = next;
    }

    /// <summary>构建互动输入上下文（人物渲染区域归一化坐标 + 视口物理像素）。</summary>
    private InteractionContext BuildInteractionContext(Point windowPos, bool pressed)
    {
        var image = GetActivePetVisual();
        var origin = image.TranslatePoint(new Point(0, 0), this);
        double w = image.ActualWidth;
        double h = image.ActualHeight;
        double nx = w > 0 ? (windowPos.X - origin.X) / w : 0;
        double ny = h > 0 ? (windowPos.Y - origin.Y) / h : 0;
        nx = Math.Clamp(nx, 0, 1);
        ny = Math.Clamp(ny, 0, 1);

        var dpi = VisualTreeHelper.GetDpi(this);
        double dt = 0.016;
        if (_lastInteractionTime is not null)
            dt = Math.Clamp((DateTime.UtcNow - _lastInteractionTime.Value).TotalSeconds, 0.001, 0.1);
        _lastInteractionTime = DateTime.UtcNow;

        return new InteractionContext(nx, ny, nx * w * dpi.DpiScaleX, ny * h * dpi.DpiScaleY, dt, pressed);
    }

    private DateTime? _lastInteractionTime;

    // ---- 抚摸输入热路径：MouseMove 只记录最新快照，消费计时器每帧最多消费一次 ----
    private PettingPointerSnapshot _latestPettingPointer;
    private long _latestPettingPointerSequence;
    private long _lastConsumedPettingSequence = -1;
    private long _lastConsumedPointerTick;
    private readonly DispatcherTimer _pettingInputTimer;
    private int _pettingInputRateHz = 60;

    // 抚摸几何缓存：布局变化时预计算，热路径仅 Rect.Contains / 简单除法（无 TranslatePoint/GetDpi/VisualTreeHelper）
    private Rect _cachedHeadPetZoneRect;
    private Rect _cachedPetToleranceRect;
    private Point _cachedCharacterOrigin;
    private double _cachedCharacterWidthDip;
    private double _cachedCharacterHeightDip;
    private DpiScale _cachedDpi = new(1, 1);
    private bool _cachedGeometryValid;

    // 光标状态变化缓存：只有按下/松开/模式切换等状态变化时才重新赋值 Cursor
    private bool _cursorGrabbedInitialized;
    private bool _lastPettingCursorGrabbed;

    /// <summary>渲染命中区域调试覆盖层（--hit-area-debug 开启）。</summary>
    private void RenderHitAreaDebugOverlay()
    {
        HitAreaDebugOverlay.Children.Clear();
        if (!_interaction.HitArea.DebugEnabled)
        {
            HitAreaDebugOverlay.Visibility = Visibility.Collapsed;
            return;
        }

        var image = GetActivePetVisual();
        var origin = image.TranslatePoint(new Point(0, 0), this);
        double w = image.ActualWidth;
        double h = image.ActualHeight;
        if (w <= 0 || h <= 0)
            return;

        foreach (var area in _interaction.HitArea.Areas)
        {
            var (l, t, aw, ah) = area.GetBounds(_interaction.HitArea.IsMirrored);
            System.Windows.Shapes.Shape shape = area.Type == "rect"
                ? new System.Windows.Shapes.Rectangle()
                : new System.Windows.Shapes.Ellipse();
            shape.Width = Math.Max(1, aw * w);
            shape.Height = Math.Max(1, ah * h);
            shape.Fill = new SolidColorBrush(Color.FromArgb(60, 80, 180, 255));
            shape.Stroke = Brushes.SteelBlue;
            shape.StrokeThickness = 1;
            Canvas.SetLeft(shape, origin.X + l * w);
            Canvas.SetTop(shape, origin.Y + t * h);
            HitAreaDebugOverlay.Children.Add(shape);
        }
        HitAreaDebugOverlay.Visibility = Visibility.Visible;
    }


    private void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var settings = LoadSettings();
        var legacyLayout = settings.LayoutVersion == 0;
        var heightAdjustment = settings.LayoutVersion switch
        {
            0 => VerticalAnimationPadding,
            1 => VersionOneBottomExpansion,
            _ => 0
        };
        var maximumVisualWidth = GetMaximumVisualWidth();
        Width = Clamp(
            settings.Width + (legacyLayout ? HorizontalAnimationPadding * 2 : 0),
            MinimumVisualWidth + HorizontalAnimationPadding * 2,
            maximumVisualWidth + HorizontalAnimationPadding * 2);
        Height = Clamp(
            settings.Height + heightAdjustment,
            MinimumVisualWidth * 470 / 300 + VerticalAnimationPadding,
            maximumVisualWidth * 470 / 300 + VerticalAnimationPadding);
        Topmost = settings.Topmost;
        _petRunning = settings.PetRunning;
        _autoActions = settings.AutoActions;
        _snapToEdge = settings.SnapToEdge;
        _timeGreetingEnabled = settings.TimeGreetingEnabled;
        _mealReminderEnabled = settings.MealReminderEnabled;
        _nightRestReminderEnabled = settings.NightRestReminderEnabled;
        _weatherGreetingEnabled = settings.WeatherGreetingEnabled;
        _randomSpeechEnabled = settings.RandomSpeechEnabled;
        _randomSpeechIntervalMinutes = Math.Clamp(
            settings.RandomSpeechIntervalMinutes,
            1,
            60);
        _character = NormalizeCharacter(settings.Character);
        _touchSoundEnabled = settings.TouchSoundEnabled;
        _touchSoundSource = settings.TouchSoundSource == "custom" ? "custom" : "default";
        _customTouchSoundPath = File.Exists(settings.CustomTouchSoundPath)
            ? settings.CustomTouchSoundPath
            : null;
        if (_customTouchSoundPath is null)
            _touchSoundSource = "default";
        _touchSoundVolume = Clamp(settings.TouchSoundVolume, 0, 1);
        _lastGreetingKey = settings.LastGreetingKey;
        _lastWeatherGreetingDate = settings.LastWeatherGreetingDate;
        _lookAtEnabled = settings.Live2DLookAtEnabled;
        _gazeFollowMode = settings.GazeFollowMode == "global" ? GazeFollowMode.Global : GazeFollowMode.Nearby;
        _gazeSpeed = Clamp(settings.GazeSpeedMultiplier, 1, 5);
        _physicsStrength = Clamp(settings.PhysicsStrength, 0, 2);
        _physicsOutputAmplitude = Clamp(settings.Live2DPhysicsOutputAmplitude, 0, 2);
        _gazeIdleTimeoutSeconds = Clamp(settings.GazeIdleTimeoutSeconds, 0.1, 30);
        _gazeHeadFollowAmount = Clamp(settings.Live2DGazeHeadFollowAmount, 0.2, 1.0);
        // 启动默认 PNG 人物模式（不读取上次 Live2D 设置，符合"进入后手动切换"要求；
        // 测试参数如需 Live2D 会在下方显式强制 _rendererMode=Live2D）
        _rendererMode = CharacterRenderMode.Existing;
        SetPetImage(false);

        if (double.IsFinite(settings.Left) && double.IsFinite(settings.Top))
        {
            Left = settings.Left - (legacyLayout ? HorizontalAnimationPadding : 0);
            Top = settings.Top - (legacyLayout ? TopAnimationPaddingDelta : 0);
        }
        else
        {
            Left = SystemParameters.WorkArea.Right
                   - Width
                   + HorizontalAnimationPadding
                   - 30;
            Top = SystemParameters.WorkArea.Bottom - Height - 20;
        }

        ClampToWorkArea();
        ApplyPetRunningState();

        // 启动：等首次布局完成后统一定位工具栏（位于人物下方居中）
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(UpdateCharacterToolbarPlacement));

        // 启动：后台预加载 Live2D（不切换显示模式，保持 PNG）；
        // 测试参数显式要求 Live2D 时才自动激活
        Dispatcher.BeginInvoke(async () =>
        {
            if (_rendererMode == CharacterRenderMode.Live2D)
                await ApplyInitialRendererModeAsync();
            else
                await PreloadLive2DInternalAsync();
        });

        // 隐藏测试参数：--autoswitch N 自动执行 N 次模式切换并退出
        var autoSwitchArg = Environment.GetCommandLineArgs()
            .Skip(1).Select(a => a.StartsWith("--autoswitch=") ? a.Substring("--autoswitch=".Length) : null)
            .FirstOrDefault(v => v is not null);
        if (autoSwitchArg is not null && int.TryParse(autoSwitchArg, out int autoSwitchCount) && autoSwitchCount > 0)
            Dispatcher.BeginInvoke(async () =>
            {
                await RunAutoSwitchTestAsync(autoSwitchCount);
                AppLog.Info("自动切换测试退出");
                Close();
            });

        // 隐藏测试参数：--native-export-audit / --native-abi-test / --lip-sync-test /
        // --lip-sync-missing-export-test / --live2d-activation-speak-test /
        // --runtime-settings-apply-test / --mouse-idle-timeout-test /
        // --physics-strength-runtime-test / --renderer-recreate-settings-test /
        // --physics-input-gain-test / --physics-visible-pose-isolation-test /
        // --physics-output-overwrite-test / --physics-editor-equivalence-test / --physics-60hz-test /
        // --physics-drive-diagnostic（常规启动 + 250ms 物理驱动回读，不退出）
        var args = Environment.GetCommandLineArgs().Skip(1);

        // 抚摸输入采样率诊断：--petting-input-rate=30|60（默认 60）。
        // 消费计时器与识别器都按该频率限频，对比 30Hz 与 60Hz 下帧率/手感/Native 调用次数。
        var pettingRateArg = args
            .Select(a => a.StartsWith("--petting-input-rate=") ? a.Substring("--petting-input-rate=".Length) : null)
            .FirstOrDefault(v => v is not null);
        if (pettingRateArg is not null && int.TryParse(pettingRateArg, out int pettingRate)
            && (pettingRate == 30 || pettingRate == 60))
        {
            _pettingInputRateHz = pettingRate;
            _pettingInputTimer.Interval = TimeSpan.FromMilliseconds(1000.0 / _pettingInputRateHz);
            _interaction.HeadPetting.SetInputRateHz(_pettingInputRateHz);
            AppLog.Info("PETTING_INPUT_RATE set={0}Hz", _pettingInputRateHz);
        }

        // 常规启动 + 物理驱动诊断：开启 250ms 回读日志（可见姿态 vs 物理虚拟输入），不退出
        if (args.Contains("--physics-drive-diagnostic"))
        {
            Live2DCharacterRenderer.DiagnosticsEnabled = true;
            _rendererMode = CharacterRenderMode.Live2D;
            AppLog.Info("物理驱动诊断开启（250ms 回读，强制 Live2D 模式）");
        }
        if (args.Contains("--physics-output-amplitude-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsOutputAmplitudeTestAsync(); AppLog.Info("输出幅度测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-input-output-isolation-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsInputOutputIsolationTestAsync(); AppLog.Info("输入输出隔离测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-output-feedback-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsOutputFeedbackTestAsync(); AppLog.Info("输出反馈(60s)测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-output-100-percent-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsOutput100PercentTestAsync(); AppLog.Info("100% 原始路径对比测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-output-stability-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsOutputStabilityTestAsync(); AppLog.Info("输出幅度稳定性测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-input-gain-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsInputGainTestAsync(); AppLog.Info("物理输入增益测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-visible-pose-isolation-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsVisiblePoseIsolationTestAsync(); AppLog.Info("可见姿态隔离测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-output-overwrite-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsOutputOverwriteTestAsync(); AppLog.Info("物理输出覆盖测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-editor-equivalence-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsEditorEquivalenceTestAsync(); AppLog.Info("编辑器等价性测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-60hz-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysics60HzTestAsync(); AppLog.Info("60Hz 固定步长测试退出"); Close(); });
            return;
        }
        if (args.Contains("--gaze-head-full-range-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunGazeHeadFullRangeTestAsync(); AppLog.Info("头部全范围测试退出"); Close(); });
            return;
        }
        if (args.Contains("--gaze-head-mapping-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunGazeHeadMappingTestAsync(); AppLog.Info("头部映射测试退出"); Close(); });
            return;
        }
        if (args.Contains("--gaze-weight-audit-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunGazeWeightAuditTestAsync(); AppLog.Info("视线权重审计测试退出"); Close(); });
            return;
        }
        if (args.Contains("--gaze-output-overwrite-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunGazeOutputOverwriteTestAsync(); AppLog.Info("视线输出覆盖测试退出"); Close(); });
            return;
        }
        if (args.Contains("--runtime-settings-apply-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunRuntimeSettingsApplyTestAsync(); AppLog.Info("运行设置应用测试退出"); Close(); });
            return;
        }
        if (args.Contains("--mouse-idle-timeout-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunMouseIdleTimeoutTestAsync(); AppLog.Info("鼠标静止计时测试退出"); Close(); });
            return;
        }
        if (args.Contains("--physics-strength-runtime-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPhysicsStrengthRuntimeTestAsync(); AppLog.Info("物理强度运行时测试退出"); Close(); });
            return;
        }
        if (args.Contains("--renderer-recreate-settings-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunRendererRecreateSettingsTestAsync(); AppLog.Info("渲染重建设置测试退出"); Close(); });
            return;
        }
        if (args.Contains("--native-export-audit"))
        {
            Dispatcher.BeginInvoke(() => { RunNativeExportAuditTest(); AppLog.Info("导出审计测试退出"); Close(); });
            return;
        }
        if (args.Contains("--native-abi-test"))
        {
            Dispatcher.BeginInvoke(() => { RunNativeAbiTest(); AppLog.Info("ABI 测试退出"); Close(); });
            return;
        }
        if (args.Contains("--lip-sync-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunLipSyncTestAsync(); AppLog.Info("口型测试退出"); Close(); });
            return;
        }
        if (args.Contains("--mouth-param-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunMouthParamTestAsync(); AppLog.Info("嘴型参数测试退出"); Close(); });
            return;
        }
        if (args.Contains("--dialogue-smoke-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunDialogueSmokeTestAsync(); AppLog.Info("台词冒烟测试退出"); Close(); });
            return;
        }
        if (args.Contains("--hit-area-debug"))
        {
            // 命中区域调试：显示半透明轮廓（正式默认关闭）
            _interaction.SetHitAreaDebug(true);
            SizeChanged += (_, _) => RenderHitAreaDebugOverlay();
            LocationChanged += (_, _) => RenderHitAreaDebugOverlay();
            Dispatcher.BeginInvoke(() => RenderHitAreaDebugOverlay());
        }
        if (args.Contains("--ear-root-debug"))
        {
            // 猫耳根部参数调试：每 200ms 记录根部偏移/物理基值/最终值（正式默认关闭）
            _interaction.Reaction.EarRootDebugEnabled = true;
            AppLog.Info("EAR_ROOT_DEBUG_ENABLED");
        }
        if (args.Contains("--interaction-smoke-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunInteractionSmokeTestAsync(); AppLog.Info("互动冒烟测试退出"); Close(); });
            return;
        }
        if (args.Contains("--petting-input-sim"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPettingInputSimAsync(); AppLog.Info("抚摸输入仿真退出"); });
            return;
        }
        if (args.Contains("--toolbar-placement-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunToolbarPlacementTestAsync(); AppLog.Info("工具栏定位测试退出"); });
            return;
        }
        if (args.Contains("--ear-ab-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunEarAbTestAsync(); AppLog.Info("猫耳A/B对照测试退出"); });
            return;
        }
        if (args.Contains("--mode-switch-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunModeSwitchTestAsync(); AppLog.Info("模式切换测试退出"); });
            return;
        }
        if (args.Contains("--toolbar-hit-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunToolbarHitTestAsync(); AppLog.Info("工具栏命中测试退出"); });
            return;
        }
        if (args.Contains("--toolbar-input-debug"))
        {
            Dispatcher.BeginInvoke(async () => { await RunToolbarInputDebugAsync(); AppLog.Info("工具栏输入诊断退出"); });
            return;
        }
        if (args.Contains("--petting-session-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunPettingSessionTestAsync(); AppLog.Info("抚摸会话测试退出"); });
            return;
        }
        if (args.Contains("--lip-sync-missing-export-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunLipSyncMissingExportTestAsync(); AppLog.Info("口型缺失导出测试退出"); Close(); });
            return;
        }
        if (args.Contains("--live2d-activation-speak-test"))
        {
            Dispatcher.BeginInvoke(async () => { await RunLive2DActivationSpeakTestAsync(); AppLog.Info("激活+台词测试退出"); Close(); });
            return;
        }
    }

    private void SetPetImage(bool blinking)
    {
        var fileName = _character == WindyCharacter
            ? (blinking ? "windy_pet_blink.png" : "windy_pet.png")
            : (blinking ? "aliya_pet_blink.png" : "aliya_pet.png");
        PetImage.Source = new BitmapImage(new Uri($"/Assets/{fileName}", UriKind.Relative));
    }

    private void ScheduleNextBlink()
    {
        _blinkTimer.Stop();
        if (!_petRunning)
            return;

        _blinkTimer.Interval = TimeSpan.FromMilliseconds(_random.Next(2500, 6001));
        _blinkTimer.Start();
    }

    private void SetCharacter(string character)
    {
        character = NormalizeCharacter(character);
        if (_character == character)
            return;

        _character = character;
        _openEyesTimer.Stop();
        SetPetImage(false);
        ScheduleNextBlink();
        SaveSettings();
        CancelDialogue("switch_character");
        Speak($"已切换为 {_character}。");
        InvalidateCharacterLayout();
    }

    private static string NormalizeCharacter(string? character)
    {
        return character == WindyCharacter ? WindyCharacter : AliyaCharacter;
    }

    private void UpdateIdleAnimation()
    {
        if (_dragging)
            return;

        _phase += 0.09;
        IdleTranslate.Y = Math.Sin(_phase) * 3.4;
        IdleScale.ScaleY = 1.0 + Math.Sin(_phase * 0.5) * 0.007;
        IdleScale.ScaleX = 1.0 - Math.Sin(_phase * 0.5) * 0.002;
    }

    private void ScheduleNextAutoAction()
    {
        _autoActionTimer.Stop();
        if (!_petRunning || !_autoActions)
            return;

        _autoActionTimer.Interval = TimeSpan.FromSeconds(_random.Next(8, 16));
        _autoActionTimer.Start();
    }

    private void ScheduleNextRandomSpeech()
    {
        _randomSpeechTimer.Stop();
        if (!_petRunning || !_randomSpeechEnabled)
            return;

        _randomSpeechTimer.Interval = TimeSpan.FromMinutes(_randomSpeechIntervalMinutes);
        _randomSpeechTimer.Start();
    }

    private void ApplyPetRunningState()
    {
        if (_rendererMode == CharacterRenderMode.Live2D)
        {
            if (_live2D is not null)
            {
                _live2D.SetOpacity(_petRunning ? 1 : 0.58);
                _live2D.SetState(_petRunning ? CharacterState.Wake : CharacterState.Sleep, 0);
            }
            if (!_petRunning)
            {
                _autoActionTimer.Stop();
                _randomSpeechTimer.Stop();
                _greetingTimer.Stop();
            }
            else
            {
                ScheduleNextAutoAction();
                ScheduleNextRandomSpeech();
                _greetingTimer.Start();
                if (_weatherGreetingEnabled)
                    _ = RefreshWeatherGreetingAsync(false);
            }
            return;
        }
        PetImage.Opacity = _petRunning ? 1 : 0.58;
        if (!_petRunning)
        {
            _idleTimer.Stop();
            _blinkTimer.Stop();
            _openEyesTimer.Stop();
            _autoActionTimer.Stop();
            _randomSpeechTimer.Stop();
            _greetingTimer.Stop();
            SetPetImage(false);
            ResetActionTransforms();
            return;
        }

        _idleTimer.Start();
        ScheduleNextBlink();
        ScheduleNextAutoAction();
        ScheduleNextRandomSpeech();
        _greetingTimer.Start();
        if (_weatherGreetingEnabled)
            _ = RefreshWeatherGreetingAsync(false);
    }

    private void SetPetRunning(bool running)
    {
        if (_petRunning == running)
            return;

        _petRunning = running;
        ApplyPetRunningState();

        // 启动后按设置激活初始渲染模式（等布局完成）
        SaveSettings();
        Speak(running ? "桌面宠物已启动。" : "桌面宠物已暂停，仍可拖动和右键设置。");
    }

    private async Task CheckScheduledGreetingAsync()
    {
        if (!_petRunning || _dragging || _actionRunning)
            return;

        if (_weatherGreetingEnabled
            && DateTime.Now - _weatherUpdatedAt >= TimeSpan.FromMinutes(30))
            await RefreshWeatherGreetingAsync(false);

        var now = DateTime.Now;
        var scene = _timeSceneService.GetScene(now);
        var day = scene == TimeSceneService.DeepNight && now.Hour < 2
            ? now.Date.AddDays(-1)
            : now.Date;
        var key = $"{day:yyyy-MM-dd}:{scene}";
        if (_lastGreetingKey == key)
            return;

        var timeGreetingAllowed = _timeGreetingEnabled
                                  && (scene is not TimeSceneService.Lunch
                                      and not TimeSceneService.Dinner || _mealReminderEnabled)
                                  && (scene is not TimeSceneService.LateNight
                                      and not TimeSceneService.DeepNight || _nightRestReminderEnabled);
        var weatherAvailable = _weatherGreetingEnabled
                               && _weatherGreeting is not null
                               && _lastWeatherGreetingDate != now.ToString("yyyy-MM-dd");

        if (timeGreetingAllowed)
        {
            var reminderPeriod = scene is TimeSceneService.Lunch
                or TimeSceneService.Dinner
                or TimeSceneService.LateNight
                or TimeSceneService.DeepNight;
            if (!reminderPeriod && weatherAvailable && _random.NextDouble() < 0.35)
            {
                _lastWeatherGreetingDate = now.ToString("yyyy-MM-dd");
                Speak(_weatherGreeting!);
            }
            else
            {
                _lastGreetingKey = key;
                PlayDialogue(scene);
            }
        }
        else if (weatherAvailable)
        {
            _lastWeatherGreetingDate = now.ToString("yyyy-MM-dd");
            Speak(_weatherGreeting!);
        }

        SaveSettings();
    }

    private async Task RefreshWeatherGreetingAsync(bool showResult)
    {
        try
        {
            var access = await Geolocator.RequestAccessAsync();
            if (access != GeolocationAccessStatus.Allowed)
            {
                _weatherUpdatedAt = DateTime.Now;
                if (showResult)
                {
                    Speak("未获得 Windows 位置权限，请在系统设置中开启位置服务。");
                    OpenLocationSettings();
                }
                return;
            }

            var position = await new Geolocator
            {
                DesiredAccuracy = PositionAccuracy.Default
            }.GetGeopositionAsync(TimeSpan.FromMinutes(5), TimeSpan.FromSeconds(12));
            var latitude = position.Coordinate.Point.Position.Latitude;
            var longitude = position.Coordinate.Point.Position.Longitude;
            var endpoint = string.Format(
                CultureInfo.InvariantCulture,
                "https://api.open-meteo.com/v1/forecast?latitude={0}&longitude={1}&current=temperature_2m,weather_code&timezone=auto&forecast_days=1",
                latitude,
                longitude);
            using var weatherJson = JsonDocument.Parse(
                await WeatherClient.GetStringAsync(endpoint));
            var current = weatherJson.RootElement.GetProperty("current");
            var temperature = current.GetProperty("temperature_2m").GetDouble();
            var condition = GetWeatherCondition(current.GetProperty("weather_code").GetInt32());
            _weatherGreeting = $"当地现在约 {temperature:0.#}°C，{condition}。";
            _weatherUpdatedAt = DateTime.Now;
            if (showResult)
                Speak(_weatherGreeting);
        }
        catch (Exception error) when (
            error is UnauthorizedAccessException
            || error.HResult == unchecked((int)0x80070005))
        {
            _weatherUpdatedAt = DateTime.Now;
            if (showResult)
            {
                Speak("Windows 位置权限未开启，正在打开位置设置。");
                OpenLocationSettings();
            }
        }
        catch
        {
            _weatherUpdatedAt = DateTime.Now.AddMinutes(-25);
            if (showResult)
                Speak("天气数据暂时获取失败，请检查 Windows 位置服务和网络。");
        }
    }

    private static void OpenLocationSettings()
    {
        try
        {
            Process.Start(new ProcessStartInfo("ms-settings:privacy-location")
            {
                UseShellExecute = true
            });
        }
        catch
        {
            // 无法打开系统设置时保留气泡提示。
        }
    }

    private static string GetWeatherCondition(int code)
    {
        return code switch
        {
            0 => "天气晴朗",
            1 or 2 => "晴间多云",
            3 => "多云",
            45 or 48 => "有雾",
            >= 51 and <= 57 => "有毛毛雨",
            >= 61 and <= 67 => "有雨",
            >= 71 and <= 77 => "有雪",
            >= 80 and <= 82 => "有阵雨",
            >= 85 and <= 86 => "有阵雪",
            >= 95 => "有雷雨",
            _ => "天气有些变化"
        };
    }

    private void Speak(string text)
    {
        CancelDialogue("system_message");
        SpeechText.Text = text;
        SpeechBubble.Visibility = Visibility.Visible;
        _speechTimer.Stop();
        _speechTimer.Start();
    }

    private async Task PlayRandomActionAsync(bool speak)
    {
        // Live2D 与 PNG 使用各自的动作库
        var names = _rendererMode == CharacterRenderMode.Live2D
            ? new[] { "nod", "sway", "shake", "stretch", "wave", "doubt", "angry", "yawn", "walk" }
            : new[] { "hop", "sway", "shake", "stretch", "nod", "walk" };
        await RunActionAsync(names[_random.Next(names.Length)]);
    }

    private async Task RunActionAsync(Func<Task> action)
    {
        if (_actionRunning || _dragging)
            return;

        _actionRunning = true;
        _autoActionTimer.Stop();
        ResetActionTransforms();

        try
        {
            await action();
        }
        finally
        {
            ResetActionTransforms();
            _actionRunning = false;
            ScheduleNextAutoAction();
        }
    }

    private Task HopAsync() => RunActionAsync(async () =>
    {
        await AnimateAsync(ActionScale, ScaleTransform.ScaleXProperty, 1, 1.10, 90);
        await Task.WhenAll(
            AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, -48, 210, new QuadraticEase { EasingMode = EasingMode.EaseOut }),
            AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 0.92, 1.06, 210));
        await Task.WhenAll(
            AnimateAsync(ActionTranslate, TranslateTransform.YProperty, -48, 0, 260, new BounceEase { Bounces = 1, Bounciness = 2, EasingMode = EasingMode.EaseOut }),
            AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 1.06, 0.94, 220));
        await Task.WhenAll(
            AnimateAsync(ActionScale, ScaleTransform.ScaleXProperty, 1.10, 1, 120),
            AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 0.94, 1, 120));
    });

    private Task SwayAsync() => RunActionAsync(async () =>
    {
        for (var i = 0; i < 2; i++)
        {
            await Task.WhenAll(
                AnimateAsync(ActionRotate, RotateTransform.AngleProperty, i == 0 ? 0 : 7, -7, 180),
                AnimateAsync(ActionTranslate, TranslateTransform.XProperty, i == 0 ? 0 : 6, -6, 180));
            await Task.WhenAll(
                AnimateAsync(ActionRotate, RotateTransform.AngleProperty, -7, 7, 260),
                AnimateAsync(ActionTranslate, TranslateTransform.XProperty, -6, 6, 260));
        }
        await Task.WhenAll(
            AnimateAsync(ActionRotate, RotateTransform.AngleProperty, 7, 0, 160),
            AnimateAsync(ActionTranslate, TranslateTransform.XProperty, 6, 0, 160));
    });

    private Task ShakeAsync() => RunActionAsync(async () =>
    {
        for (var i = 0; i < 4; i++)
        {
            await AnimateAsync(ActionTranslate, TranslateTransform.XProperty, i == 0 ? 0 : -8, 8, 55);
            await AnimateAsync(ActionTranslate, TranslateTransform.XProperty, 8, -8, 55);
        }
        await AnimateAsync(ActionTranslate, TranslateTransform.XProperty, -8, 0, 70);
    });

    private Task StretchAsync() => RunActionAsync(async () =>
    {
        await Task.WhenAll(
            AnimateAsync(ActionScale, ScaleTransform.ScaleXProperty, 1, 0.90, 240, new SineEase { EasingMode = EasingMode.EaseOut }),
            AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 1, 1.10, 240, new SineEase { EasingMode = EasingMode.EaseOut }),
            AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, -8, 240));
        await Task.Delay(180);
        await Task.WhenAll(
            AnimateAsync(ActionScale, ScaleTransform.ScaleXProperty, 0.90, 1, 260, new ElasticEase { Oscillations = 1, Springiness = 4, EasingMode = EasingMode.EaseOut }),
            AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 1.10, 1, 260),
            AnimateAsync(ActionTranslate, TranslateTransform.YProperty, -8, 0, 260));
    });

    private Task NodAsync() => RunActionAsync(async () =>
    {
        for (var i = 0; i < 2; i++)
        {
            await Task.WhenAll(
                AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 1, 0.94, 120),
                AnimateAsync(ActionSkew, SkewTransform.AngleXProperty, 0, -3, 120),
                AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, 10, 120));
            await Task.WhenAll(
                AnimateAsync(ActionScale, ScaleTransform.ScaleYProperty, 0.94, 1, 150),
                AnimateAsync(ActionSkew, SkewTransform.AngleXProperty, -3, 0, 150),
                AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 10, 0, 150));
        }
    });

    private Task WalkAsync() => RunActionAsync(async () =>
    {
        var (minLeft, maxLeft) = GetHorizontalBounds();
        var availableLeft = Left - minLeft;
        var availableRight = maxLeft - Left;
        var direction = availableRight >= 100 || availableRight >= availableLeft ? 1 : -1;
        var distance = Math.Min(140, direction > 0 ? availableRight : availableLeft);

        if (distance < 28)
        {
            await HopCoreAsync();
            return;
        }

        ActionScale.ScaleX = 1;
        var targetLeft = Left + direction * distance;
        var windowMove = AnimateAsync(this, LeftProperty, Left, targetLeft, 900, new SineEase { EasingMode = EasingMode.EaseInOut });

        for (var i = 0; i < 5; i++)
        {
            await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, -8, 80);
            await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, -8, 0, 80);
        }

        await windowMove;
        Left = targetLeft;
        BeginAnimation(LeftProperty, null);
    });

    private async Task HopCoreAsync()
    {
        await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, -30, 170, new QuadraticEase { EasingMode = EasingMode.EaseOut });
        await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, -30, 0, 210, new QuadraticEase { EasingMode = EasingMode.EaseIn });
    }

    private static Task AnimateAsync(
        DependencyObject target,
        DependencyProperty property,
        double from,
        double to,
        int milliseconds,
        IEasingFunction? easing = null)
    {
        var completion = new TaskCompletionSource<bool>();
        var animation = new DoubleAnimation
        {
            From = from,
            To = to,
            Duration = TimeSpan.FromMilliseconds(milliseconds),
            EasingFunction = easing,
            FillBehavior = FillBehavior.HoldEnd
        };

        animation.Completed += (_, _) => completion.TrySetResult(true);

        switch (target)
        {
            case Animatable animatable:
                animatable.BeginAnimation(property, animation, HandoffBehavior.SnapshotAndReplace);
                break;
            case UIElement element:
                element.BeginAnimation(property, animation, HandoffBehavior.SnapshotAndReplace);
                break;
            default:
                completion.TrySetResult(true);
                break;
        }

        return completion.Task;
    }

    private void ResetActionTransforms()
    {
        ClearAnimation(ActionScale, ScaleTransform.ScaleXProperty);
        ClearAnimation(ActionScale, ScaleTransform.ScaleYProperty);
        ClearAnimation(ActionSkew, SkewTransform.AngleXProperty);
        ClearAnimation(ActionSkew, SkewTransform.AngleYProperty);
        ClearAnimation(ActionRotate, RotateTransform.AngleProperty);
        ClearAnimation(ActionTranslate, TranslateTransform.XProperty);
        ClearAnimation(ActionTranslate, TranslateTransform.YProperty);

        ActionScale.ScaleX = 1;
        ActionScale.ScaleY = 1;
        ActionSkew.AngleX = 0;
        ActionSkew.AngleY = 0;
        ActionRotate.Angle = 0;
        ActionTranslate.X = 0;
        ActionTranslate.Y = 0;
    }

    private static void ClearAnimation(Animatable target, DependencyProperty property)
    {
        target.BeginAnimation(property, null);
    }

    private void PlayTouchSound(bool preview = false)
    {
        if (!preview && (!_petRunning || !_touchSoundEnabled))
            return;

        var path = _touchSoundSource == "custom" && File.Exists(_customTouchSoundPath)
            ? _customTouchSoundPath
            : _defaultTouchSoundPath;
        if (!File.Exists(path))
            return;

        _touchSoundPlayer.Stop();
        _touchSoundPlayer.Close();
        _touchSoundPlayer.Volume = _touchSoundVolume;
        _touchSoundPlayer.Open(new Uri(path, UriKind.Absolute));
        _touchSoundPlayer.Play();
    }

    private void ImportTouchSound()
    {
        var dialog = new OpenFileDialog
        {
            Title = "导入人物触摸音效",
            Filter = "音频文件|*.wav;*.mp3;*.wma;*.m4a|所有文件|*.*"
        };
        if (dialog.ShowDialog(this) != true)
            return;

        try
        {
            var extension = Path.GetExtension(dialog.FileName);
            var destination = Path.Combine(_settingsDirectory, $"custom_touch_sound{extension}");
            File.Copy(dialog.FileName, destination, true);
            _customTouchSoundPath = destination;
            _touchSoundSource = "custom";
            SaveSettings();
            Speak($"已导入音效：{Path.GetFileName(dialog.FileName)}");
            PlayTouchSound(true);
        }
        catch
        {
            Speak("音效导入失败，请选择常见音频格式。");
        }
    }

    private void RestoreDefaultTouchSound()
    {
        _touchSoundSource = "default";
        SaveSettings();
        Speak("已恢复默认触摸音效。");
        PlayTouchSound(true);
    }

    private void Window_DpiChanged(object sender, DpiChangedEventArgs e)
    {
        // Windows DPI 变化后重新定位工具栏与命中区域调试层
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            UpdateCharacterToolbarPlacement();
            RenderHitAreaDebugOverlay();
        }));
    }

    private void PetImage_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        var downCtx = BuildInteractionContext(e.GetPosition(this), pressed: true);
        if (_interaction.OnPointerDown(downCtx))
        {
            // 抚摸按压：光标切换为握拳 Grabbing
            ApplyPettingCursorByState();
            // 捕获人物层：即使鼠标移出人物控件也能继续收到 MouseMove / MouseLeftButtonUp
            Mouse.Capture(GetActivePetVisual(), CaptureMode.Element);
            e.Handled = true;
            return;
        }
        if (_actionRunning)
            return;

        _dragging = true;
        _pointerMoved = false;
        _longPressFired = false;
        _longPressTimer?.Start();
        _mouseStart = PointToScreen(e.GetPosition(this));
        _lastMouse = _mouseStart;
        _dragDpi = VisualTreeHelper.GetDpi(this);
        _leftStart = Left;
        _topStart = Top;
        _autoActionTimer.Stop();
        _openEyesTimer.Stop();
        if (_rendererMode != CharacterRenderMode.Live2D)
        {
            SetPetImage(false);
            ScheduleNextBlink();
        }
        ((UIElement)sender).CaptureMouse();
        if (_rendererMode == CharacterRenderMode.Live2D)
            _live2D?.SetState(CharacterState.Drag, 0);
        e.Handled = true;
    }

    private void PetImage_MouseMove(object sender, MouseEventArgs e)
    {
        // 抚摸热路径：O(1)。只记录最新输入快照，不在此驱动 Native/识别/反应/光标/容错区结束/布局。
        // 全部互动处理由 _pettingInputTimer（30/60Hz 消费计时器）每帧最多执行一次。
        var windowPos = e.GetPosition(this);
        bool leftPressed = e.LeftButton == MouseButtonState.Pressed;
        PettingPerfDiagnostics.CountMouseEvent();
        _latestPettingPointer = new PettingPointerSnapshot(
            windowPos,
            Stopwatch.GetTimestamp(),
            leftPressed,
            _cachedGeometryValid && _cachedPetToleranceRect.Contains(windowPos),
            ++_latestPettingPointerSequence);

        // 自定义覆盖层禁用时不更新指针图标位置；鼠标坐标只交给 HitArea/抚摸轨迹识别
        if (UseCustomPettingCursor)
            UpdatePalmCursor(windowPos, leftPressed);

        // 抚摸模式：输入由消费计时器处理（本方法不返回"已接管"判定，消费时统一处理）
        if (_interaction.IsPettingModeActive)
        {
            e.Handled = true;
            return;
        }

        // 非抚摸模式：仅保留窗口拖动路径（不属于抚摸热路径，行为不变）
        if (!_dragging || e.LeftButton != MouseButtonState.Pressed)
            return;

        var current = PointToScreen(e.GetPosition(this));
        var deltaX = (current.X - _mouseStart.X) / _dragDpi.DpiScaleX;
        var deltaY = (current.Y - _mouseStart.Y) / _dragDpi.DpiScaleY;
        if (Math.Abs(deltaX) > DragThreshold || Math.Abs(deltaY) > DragThreshold)
        {
            _pointerMoved = true;
            _longPressTimer?.Stop();
            HideQuickActions();
        }

        Left = _leftStart + deltaX;
        Top = _topStart + deltaY;

        var frameDx = (current.X - _lastMouse.X) / _dragDpi.DpiScaleX;
        var frameDy = (current.Y - _lastMouse.Y) / _dragDpi.DpiScaleY;
        ActionRotate.Angle = Clamp(frameDx * 1.4, -7, 7);
        ActionScale.ScaleY = 1.02;
        _dragIntensity = Math.Sqrt(frameDx * frameDx + frameDy * frameDy) * 60.0;
        if (_rendererMode == CharacterRenderMode.Live2D)
            _live2D?.SetState(CharacterState.Drag, _dragIntensity);
        _lastMouse = current;
    }

    /// <summary>消费最新抚摸输入（消费计时器回调，30/60Hz）。每帧最多消费一次，过期输入直接丢弃。</summary>
    private void ConsumePettingInput()
    {
        var snap = _latestPettingPointer;
        if (snap.Sequence == _lastConsumedPettingSequence)
            return; // 无新输入
        _lastConsumedPettingSequence = snap.Sequence;

        if (!_interaction.IsPettingModeActive)
            return; // 非抚摸模式不消费（近距/识别/反应均无下游消费者）

        var ctx = BuildPettingContext(snap);
        bool consumed = _interaction.OnPointerMove(ctx);
        if (!consumed)
            return;

        _longPressTimer?.Stop();
        // 光标只在状态变化时切换（内部缓存，未变化不重新赋值）
        ApplyPettingCursorByState();
        // 指针移出容错区域 → 立即结束并睁眼恢复（按住左键移出后不会永久闭眼）
        if (!snap.IsInsideToleranceZone)
            _interaction.HeadPetting.EndPettingSession(PettingEndReason.PointerOutsideTolerance);
    }

    /// <summary>基于缓存几何构建互动上下文（O(1)，无 TranslatePoint/GetDpi/ActualWidth 读取）。</summary>
    private InteractionContext BuildPettingContext(PettingPointerSnapshot snap)
    {
        double w = _cachedCharacterWidthDip;
        double h = _cachedCharacterHeightDip;
        double nx = w > 0 ? (snap.Position.X - _cachedCharacterOrigin.X) / w : 0;
        double ny = h > 0 ? (snap.Position.Y - _cachedCharacterOrigin.Y) / h : 0;
        nx = Math.Clamp(nx, 0, 1);
        ny = Math.Clamp(ny, 0, 1);
        double dt = _lastConsumedPointerTick == 0
            ? 0.016
            : Math.Clamp((snap.Timestamp - _lastConsumedPointerTick) / (double)Stopwatch.Frequency, 0.001, 0.1);
        _lastConsumedPointerTick = snap.Timestamp;
        return new InteractionContext(nx, ny, nx * w * _cachedDpi.DpiScaleX, ny * h * _cachedDpi.DpiScaleY, dt, snap.IsLeftButtonPressed);
    }

    /// <summary>预计算抚摸几何缓存（headPetZone / 容错区 / 人物原点与尺寸 / DPI）。
    /// 只在布局变化（模式切换/缩放/DPI/窗口尺寸/工具栏尺寸）时调用，热路径仅做 Rect.Contains。</summary>
    private void UpdateCachedPettingGeometry()
    {
        _cachedGeometryValid = false;
        var image = GetActivePetVisual();
        if (image is null || image.ActualWidth <= 0 || image.ActualHeight <= 0)
            return;
        var origin = image.TranslatePoint(new Point(0, 0), this);
        if (!double.IsFinite(origin.X) || !double.IsFinite(origin.Y)
            || !double.IsFinite(image.ActualWidth) || !double.IsFinite(image.ActualHeight))
            return;

        _cachedCharacterOrigin = origin;
        _cachedCharacterWidthDip = image.ActualWidth;
        _cachedCharacterHeightDip = image.ActualHeight;
        _cachedDpi = VisualTreeHelper.GetDpi(this);

        _cachedHeadPetZoneRect = new Rect();
        _cachedPetToleranceRect = new Rect();
        var area = _interaction.HitArea.HeadPetZone;
        if (area is not null)
        {
            var (nl, nt, nw, nh) = area.GetBounds(_interaction.HitArea.IsMirrored);
            var zone = new Rect(
                origin.X + nl * image.ActualWidth,
                origin.Y + nt * image.ActualHeight,
                nw * image.ActualWidth,
                nh * image.ActualHeight);
            _cachedHeadPetZoneRect = zone;
            var tolerance = zone;
            tolerance.Inflate(32, 28);
            _cachedPetToleranceRect = tolerance;
        }
        _cachedGeometryValid = true;
    }

    private async void PetImage_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        var upCtx = BuildInteractionContext(e.GetPosition(this), pressed: false);
        bool consumed = _interaction.OnPointerUp(upCtx);
        if (consumed)
        {
            if (_dragging)
            {
                _dragging = false;
                ((UIElement)sender).ReleaseMouseCapture();
                ActionRotate.Angle = 0;
                ActionScale.ScaleY = 1;
            }
            // 松开：光标恢复张开手掌 OpenHand
            ApplyPettingCursorByState();
            e.Handled = true;
            return;
        }
        if (!_dragging)
            return;

        _longPressTimer?.Stop();
        _dragging = false;
        ((UIElement)sender).ReleaseMouseCapture();
        ActionRotate.Angle = 0;
        ActionScale.ScaleY = 1;

        if (_longPressFired)
        {
            e.Handled = true;
            return;
        }

        if (_pointerMoved)
        {
            if (_snapToEdge)
                await SnapToNearestEdgeAsync();
            else
                ClampToWorkArea();
            SaveSettings();
            if (_rendererMode == CharacterRenderMode.Live2D)
                SyncRendererState();
            _interaction.OnClick(upCtx, wasDrag: true);
        }
        else
        {
            HandleClickAsyncCore();
        }

        if (_petRunning)
            ScheduleNextAutoAction();
        if (((UIElement)sender).IsMouseOver)
            ShowQuickActions();
        e.Handled = true;
    }

    private void PetImage_MouseEnter(object sender, MouseEventArgs e)
    {
        var ctx = BuildInteractionContext(e.GetPosition(this), e.LeftButton == MouseButtonState.Pressed);
        _interaction.OnPointerEnter(ctx);
        ShowQuickActions();
    }

    private void PetImage_MouseLeave(object sender, MouseEventArgs e)
    {
        _interaction.OnPointerLeave();
        // 不立即隐藏：启动延迟隐藏倒计时，鼠标进入连接走廊/工具栏时取消
        ScheduleToolbarHide();
    }

    private void HoverQuickActions_MouseEnter(object sender, MouseEventArgs e)
    {
        CancelToolbarHide();
        ShowQuickActions();
        if (_interaction.IsPettingModeActive)
        {
            // 工具栏区域恢复普通箭头（人物区域保持 Grabbing.cur）
            _cursorGrabbedInitialized = false; // 工具栏光标是显式赋值，离开后需重新建立抚摸光标状态
            PetImage.Cursor = Cursors.Arrow;
            Live2DImage.Cursor = Cursors.Arrow;
        }
        // 释放可能残留的人物层鼠标捕获，避免按钮无法接收点击（不处于拖动/抚摸按压时）
        if (!_dragging && _interaction.HeadPetting.State is not (PettingState.Pressed or PettingState.Petting)
            && Mouse.Captured is not null && !IsToolbarInputSource(Mouse.Captured as DependencyObject))
        {
            AppLog.Info("MOUSE_CAPTURE_STATE capturedElement={0} reason=toolbar_enter_release", Mouse.Captured.GetType().Name);
            Mouse.Capture(null);
        }
    }

    private void HoverQuickActions_MouseLeave(object sender, MouseEventArgs e)
    {
        if (_interaction.IsPettingModeActive)
        {
            _cursorGrabbedInitialized = false;
            ApplyPettingCursorState(true); // 返回人物区域恢复 Grabbing
        }
        ScheduleToolbarHide();
    }

    /// <summary>鼠标进入人物与工具栏之间的透明连接走廊：取消隐藏并保持工具栏显示。</summary>
    private void ToolbarHoverBridge_MouseEnter(object sender, MouseEventArgs e)
    {
        CancelToolbarHide();
        ShowQuickActions();
    }

    private void ToolbarHoverBridge_MouseLeave(object sender, MouseEventArgs e)
    {
        ScheduleToolbarHide();
    }

    private void ShowQuickActions()
    {
        CancelToolbarHide();
        UpdateCharacterToolbarPlacement();
        if (HoverQuickActions.Visibility == Visibility.Visible)
            return;

        HoverQuickActions.Visibility = Visibility.Visible;
        HoverQuickActions.IsHitTestVisible = true;
        HoverQuickActions.BeginAnimation(
            OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(140)));
        HoverQuickActionsTranslate.BeginAnimation(
            TranslateTransform.YProperty,
            new DoubleAnimation(6, 0, TimeSpan.FromMilliseconds(140))
            {
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut }
            });
    }

    /// <summary>启动延迟隐藏倒计时（1200ms）。抚摸模式选中时固定显示，不启动倒计时。</summary>
    private void ScheduleToolbarHide()
    {
        if (IsToolbarPinned())
        {
            CancelToolbarHide();
            return;
        }
        _hoverHideTimer.Stop();
        _hoverHideTimer.Start();
    }

    private void CancelToolbarHide() => _hoverHideTimer.Stop();

    private void HideQuickActions()
    {
        if (HoverQuickActions.Visibility == Visibility.Collapsed)
            return;
        HoverQuickActions.BeginAnimation(OpacityProperty, null);
        HoverQuickActionsTranslate.BeginAnimation(TranslateTransform.YProperty, null);
        HoverQuickActions.Visibility = Visibility.Collapsed;
        HoverQuickActions.IsHitTestVisible = false;
        ToolbarHoverBridge.Visibility = Visibility.Collapsed;
    }

    // ==================== 工具栏统一布局（PNG/Live2D 共用，父级=CharacterToolbarLayer） ====================

    private const double ToolbarGap = 8; // DIP，人物底部与工具栏间距（6~10）
    private const double ToolbarHideDelayMilliseconds = 1200;
    private const double DefaultToolbarWidth = 318;
    private Rect _currentCharacterBounds = Rect.Empty;

    /// <summary>人物当前在窗口 DIP 坐标系下的实际显示矩形（不使用纹理像素/模型坐标/旧资源尺寸）。</summary>
    private Rect GetCharacterVisualBounds()
    {
        var image = GetActivePetVisual();
        if (image is null || image.ActualWidth <= 0 || image.ActualHeight <= 0)
            return Rect.Empty;
        var origin = image.TranslatePoint(new Point(0, 0), this);
        if (!double.IsFinite(origin.X) || !double.IsFinite(origin.Y)
            || !double.IsFinite(image.ActualWidth) || !double.IsFinite(image.ActualHeight))
            return Rect.Empty;
        return new Rect(origin.X, origin.Y, image.ActualWidth, image.ActualHeight);
    }

    private static bool IsValidBounds(Rect r)
    {
        return !r.IsEmpty
               && r.Width > 0 && r.Height > 0
               && double.IsFinite(r.Left) && double.IsFinite(r.Top)
               && double.IsFinite(r.Width) && double.IsFinite(r.Height);
    }

    /// <summary>统一工具栏定位：toolbarCenterX = 人物中心X，toolbarTop = 人物底部 + Gap。DIP 坐标。</summary>
    private void UpdateCharacterToolbarPlacement()
    {
        var bounds = GetCharacterVisualBounds();
        if (!IsValidBounds(bounds))
        {
            // 人物边界暂时无效：保持上一次位置或隐藏，禁止回退到 0,0（左上角）
            if (HoverQuickActions.Visibility == Visibility.Visible)
                HoverQuickActions.Visibility = Visibility.Collapsed;
            return;
        }

        _currentCharacterBounds = bounds;
        double centerX = bounds.Left + bounds.Width / 2;
        double top = bounds.Top + bounds.Height + ToolbarGap;
        double toolbarWidth = HoverQuickActions.ActualWidth > 0 ? HoverQuickActions.ActualWidth : DefaultToolbarWidth;
        double toolbarLeft = Math.Max(0, centerX - toolbarWidth / 2);
        Canvas.SetLeft(HoverQuickActions, toolbarLeft);
        Canvas.SetTop(HoverQuickActions, Math.Max(0, top));
        UpdateToolbarHoverBridge(bounds, toolbarWidth, toolbarLeft, top);
        // 布局变化时同步预计算抚摸几何缓存（热路径只做 Rect.Contains）
        UpdateCachedPettingGeometry();
    }

    /// <summary>更新人物与工具栏之间的透明连接走廊（可命中，保持工具栏显示）。
    /// Bounds 严格截止于工具栏顶部，不覆盖 HoverQuickActions 按钮。</summary>
    private void UpdateToolbarHoverBridge(Rect bounds, double toolbarWidth, double toolbarLeft, double toolbarTop)
    {
        double bridgeWidth = Math.Max(toolbarWidth + 30, 320);       // 工具栏宽度 + 左右容错
        double bridgeLeft = Math.Max(0, bounds.Left + bounds.Width / 2 - bridgeWidth / 2);
        double bridgeTop = bounds.Top + bounds.Height;               // 人物底部
        double bridgeHeight = toolbarTop - bridgeTop;                // 截止于工具栏顶部（不覆盖按钮）
        ToolbarHoverBridge.Width = bridgeWidth;
        ToolbarHoverBridge.Height = Math.Max(1, bridgeHeight);
        Canvas.SetLeft(ToolbarHoverBridge, bridgeLeft);
        Canvas.SetTop(ToolbarHoverBridge, bridgeTop);
        ToolbarHoverBridge.Visibility = HoverQuickActions.Visibility;
    }

    /// <summary>切换模式/缩放/DPI/角色等布局失效时：清空旧边界，暂时禁用工具栏交互，布局完成后恢复并重定位。</summary>
    private void InvalidateCharacterLayout()
    {
        _currentCharacterBounds = Rect.Empty;
        SetToolbarInteractive(false);
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            UpdateCharacterToolbarPlacement();
            SetToolbarInteractive(true);
            if (IsPointerInsideToolbarInteractionRegion() || IsToolbarPinned())
                ShowQuickActions();
            else
                ScheduleToolbarHide();
        }));
    }

    /// <summary>切换期间暂时禁用工具栏交互（Hidden 保留布局）；完成后恢复 Visible/IsHitTestVisible/IsEnabled。</summary>
    private void SetToolbarInteractive(bool interactive)
    {
        if (interactive)
        {
            HoverQuickActions.IsEnabled = true;
            HoverQuickActions.IsHitTestVisible = true;
            if (HoverQuickActions.Visibility != Visibility.Visible)
                HoverQuickActions.Visibility = Visibility.Visible;
        }
        else
        {
            HoverQuickActions.IsEnabled = false;
            HoverQuickActions.IsHitTestVisible = false;
            HoverQuickActions.Visibility = Visibility.Hidden;
        }
    }

    /// <summary>
    /// 模式切换后的统一恢复方法（成功/失败/取消都调用）：
    /// 恢复工具栏所有父级与按钮的交互状态、释放鼠标捕获、重新定位工具栏。
    /// </summary>
    private void RestoreToolbarAfterCharacterModeSwitch()
    {
        CharacterToolbarLayer.IsHitTestVisible = true;
        CharacterToolbarLayer.IsEnabled = true;
        HoverQuickActions.IsEnabled = true;
        HoverQuickActions.IsHitTestVisible = true;
        HeadPettingButton.IsEnabled = true;
        if (HoverQuickActions.Visibility != Visibility.Visible)
            HoverQuickActions.Visibility = Visibility.Visible;
        // 不主动重新 Capture 人物层；释放残留捕获（若捕获属于人物层）
        if (Mouse.Captured is not null && !IsToolbarInputSource(Mouse.Captured as DependencyObject))
        {
            AppLog.Info("MOUSE_CAPTURE_STATE capturedElement={0} reason=mode_switch_release", Mouse.Captured.GetType().Name);
            Mouse.Capture(null);
        }
        // 布局完成后重定位工具栏与连接走廊
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            UpdateCharacterToolbarPlacement();
            if (IsPointerInsideToolbarInteractionRegion() || IsToolbarPinned())
                ShowQuickActions();
            else
                ScheduleToolbarHide();
        }));
    }

    /// <summary>判断事件来源或其祖先是否属于工具栏（Visual 与 Logical 父级均检查）。
    /// 工具栏输入不进入人物拖动/抚摸/点击逻辑，不设置 e.Handled。</summary>
    private bool IsToolbarInputSource(DependencyObject? source)
    {
        DependencyObject? current = source;
        while (current != null)
        {
            if (ReferenceEquals(current, CharacterToolbarLayer)
                || ReferenceEquals(current, HoverQuickActions))
            {
                return true;
            }
            current = VisualTreeHelper.GetParent(current)
                      ?? LogicalTreeHelper.GetParent(current);
        }
        return false;
    }

    /// <summary>全窗口 Preview 鼠标按下：来源属于工具栏时不设置 e.Handled，让按钮正常处理事件。</summary>
    private void Window_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (IsToolbarInputSource(e.OriginalSource as DependencyObject))
        {
            CancelToolbarHide();
            ShowQuickActions();
            return; // 不 e.Handled=true、不 CaptureMouse、不进入人物逻辑
        }
    }

    /// <summary>工具栏是否固定显示（抚摸模式选中/正在抚摸时不自动隐藏）。</summary>
    private bool IsToolbarPinned()
    {
        return _interaction.IsPettingModeActive || HeadPettingButton.IsChecked == true;
    }

    private Rect ToolbarRect()
    {
        double left = Canvas.GetLeft(HoverQuickActions);
        double top = Canvas.GetTop(HoverQuickActions);
        double w = HoverQuickActions.ActualWidth > 0 ? HoverQuickActions.ActualWidth : DefaultToolbarWidth;
        double h = HoverQuickActions.ActualHeight > 0 ? HoverQuickActions.ActualHeight : 50;
        return new Rect(left, top, w, h);
    }

    /// <summary>
    /// 统一悬停区域判断：人物可见区域 / 工具栏区域 / 透明连接走廊 / 工具栏周围容错扩展。
    /// 所有隐藏决策必须经过此方法。
    /// </summary>
    private bool IsPointerInsideToolbarInteractionRegion()
    {
        if (_currentCharacterBounds.Contains(Mouse.GetPosition(this)))
            return true;

        var toolbar = ToolbarRect();
        if (toolbar.Contains(Mouse.GetPosition(this)))
            return true;

        if (ToolbarHoverBridge.Visibility == Visibility.Visible)
        {
            double bLeft = Canvas.GetLeft(ToolbarHoverBridge);
            double bTop = Canvas.GetTop(ToolbarHoverBridge);
            if (new Rect(bLeft, bTop, ToolbarHoverBridge.ActualWidth, ToolbarHoverBridge.ActualHeight).Contains(Mouse.GetPosition(this)))
                return true;
        }

        var inflated = toolbar;
        inflated.Inflate(12, 12);
        return inflated.Contains(Mouse.GetPosition(this));
    }

    private bool IsPointerOverPetArea()
    {
        if (_currentCharacterBounds.IsEmpty)
            return false;
        var pos = Mouse.GetPosition(this);
        return _currentCharacterBounds.Contains(pos);
    }

    private async void HoverWeather_Click(object sender, RoutedEventArgs e)
    {
        await RefreshWeatherGreetingAsync(true);
        e.Handled = true;
    }

    private async void HoverAction_Click(object sender, RoutedEventArgs e)
    {
        if (_petRunning)
            await PlayRandomActionAsync(false);
        else
            Speak("请先启动桌面宠物。");
        e.Handled = true;
    }

    private void HoverTalk_Click(object sender, RoutedEventArgs e)
    {
        PlayDialogue(UserClickScene);
        e.Handled = true;
    }

    private void PetImage_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        var factor = e.Delta > 0 ? 1.08 : 0.92;
        SetPetSize((Width - HorizontalAnimationPadding * 2) * factor);
        e.Handled = true;
    }

    private void SetPetSize(double width)
    {
        var oldBottom = Top + Height;
        var visualWidth = Clamp(width, MinimumVisualWidth, GetMaximumVisualWidth());
        Width = visualWidth + HorizontalAnimationPadding * 2;
        Height = Math.Max(
            MinimumVisualWidth * 470 / 300 + VerticalAnimationPadding,
            visualWidth * 470 / 300 + VerticalAnimationPadding);
        Top = oldBottom - Height;
        if (_rendererMode == CharacterRenderMode.Live2D)
            ResizeLive2D();
        ClampToWorkArea();
        SaveSettings();
        // 人物缩放后重新定位工具栏
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(UpdateCharacterToolbarPlacement));
    }

    private static double GetMaximumVisualWidth()
    {
        var workArea = SystemParameters.WorkArea;
        var maximumByWidth = workArea.Width - HorizontalAnimationPadding * 2;
        var maximumByHeight = (workArea.Height - VerticalAnimationPadding) * 300 / 470;

        return Clamp(
            Math.Min(MaximumVisualWidth, Math.Min(maximumByWidth, maximumByHeight)),
            MinimumVisualWidth,
            MaximumVisualWidth);
    }

    private async Task SnapToNearestEdgeAsync()
    {
        ClampToWorkArea();
        var (minLeft, maxLeft) = GetHorizontalBounds();
        var leftDistance = Math.Abs(Left - minLeft);
        var rightDistance = Math.Abs(maxLeft - Left);
        if (leftDistance > EdgeSnapThreshold && rightDistance > EdgeSnapThreshold)
            return;

        var target = leftDistance <= rightDistance ? minLeft : maxLeft;

        var start = Left;
        await AnimateAsync(this, LeftProperty, start, target, 180, new QuadraticEase { EasingMode = EasingMode.EaseOut });
        Left = target;
        BeginAnimation(LeftProperty, null);
    }

    private void ClampToWorkArea()
    {
        var area = SystemParameters.WorkArea;
        var (minLeft, maxLeft) = GetHorizontalBounds();
        Left = Clamp(Left, minLeft, maxLeft);
        Top = Clamp(Top, area.Top, Math.Max(area.Top, area.Bottom - Height));
    }

    private (double Min, double Max) GetHorizontalBounds()
    {
        var area = SystemParameters.WorkArea;
        var inset = GetVisibleHorizontalInset();
        return (area.Left - inset, area.Right - Width + inset);
    }

    private double GetVisibleHorizontalInset()
    {
        if (((Image)GetActivePetVisual()).Source is null
            || ((Image)GetActivePetVisual()).ActualWidth <= 0
            || ((Image)GetActivePetVisual()).ActualHeight <= 0)
            return 0;

        var scale = Math.Min(
            ((Image)GetActivePetVisual()).ActualWidth / ((Image)GetActivePetVisual()).Source.Width,
            ((Image)GetActivePetVisual()).ActualHeight / ((Image)GetActivePetVisual()).Source.Height);
        var renderedWidth = ((Image)GetActivePetVisual()).Source.Width * scale;
        var imageLeft = ((Image)GetActivePetVisual()).TranslatePoint(new Point(0, 0), this).X;
        return Math.Max(0, imageLeft + (((Image)GetActivePetVisual()).ActualWidth - renderedWidth) / 2);
    }

    private async void PetImage_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        var menu = new ContextMenu();

        var running = new MenuItem
        {
            Header = _petRunning ? "暂停桌面宠物" : "启动桌面宠物"
        };
        running.Click += (_, _) => SetPetRunning(!_petRunning);

        var talk = new MenuItem { Header = "说句话", IsEnabled = _petRunning };
        talk.Click += (_, _) => PlayDialogue(UserClickScene);

        var actions = new MenuItem { Header = "动作", IsEnabled = _petRunning };
        actions.Items.Add(CreateActionMenuItem("跳一下", () => RunActionAsync("hop")));
        actions.Items.Add(CreateActionMenuItem("左右摇摆", () => RunActionAsync("sway")));
        actions.Items.Add(CreateActionMenuItem("抖一抖", () => RunActionAsync("shake")));
        actions.Items.Add(CreateActionMenuItem("伸懒腰", () => RunActionAsync("stretch")));
        actions.Items.Add(CreateActionMenuItem("点头", () => RunActionAsync("nod")));
        actions.Items.Add(CreateActionMenuItem("走几步", () => RunActionAsync("walk")));
        actions.Items.Add(new Separator());
        actions.Items.Add(CreateActionMenuItem("随机动作", () => PlayRandomActionAsync(false)));
        actions.Items.Add(new Separator());
        var live2dActions = new MenuItem
        {
            Header = "Live2D 动作",
            IsEnabled = _petRunning && _rendererMode == CharacterRenderMode.Live2D
        };
        live2dActions.Items.Add(CreateActionMenuItem("挥手", () => RunActionAsync("wave")));
        live2dActions.Items.Add(CreateActionMenuItem("疑惑", () => RunActionAsync("doubt")));
        live2dActions.Items.Add(CreateActionMenuItem("生气", () => RunActionAsync("angry")));
        live2dActions.Items.Add(CreateActionMenuItem("打哈欠", () => RunActionAsync("yawn")));
        live2dActions.Items.Add(CreateActionMenuItem("向左走", () => RunActionAsync("walk_left")));
        live2dActions.Items.Add(CreateActionMenuItem("向右走", () => RunActionAsync("walk_right")));
        actions.Items.Add(live2dActions);

        var autoActions = new MenuItem
        {
            Header = "自动随机动作",
            IsCheckable = true,
            IsChecked = _autoActions,
            IsEnabled = _petRunning
        };
        autoActions.Click += (_, _) =>
        {
            _autoActions = autoActions.IsChecked;
            ScheduleNextAutoAction();
            SaveSettings();
        };

        var greetingSettings = new MenuItem { Header = "问候与提醒" };
        var timeGreeting = new MenuItem
        {
            Header = "时间问候",
            IsCheckable = true,
            IsChecked = _timeGreetingEnabled
        };
        timeGreeting.Click += (_, _) =>
        {
            _timeGreetingEnabled = timeGreeting.IsChecked;
            SaveSettings();
        };
        var mealReminder = new MenuItem
        {
            Header = "吃饭提醒",
            IsCheckable = true,
            IsChecked = _mealReminderEnabled,
            IsEnabled = _timeGreetingEnabled
        };
        mealReminder.Click += (_, _) =>
        {
            _mealReminderEnabled = mealReminder.IsChecked;
            SaveSettings();
        };
        var nightReminder = new MenuItem
        {
            Header = "晚间休息提醒",
            IsCheckable = true,
            IsChecked = _nightRestReminderEnabled,
            IsEnabled = _timeGreetingEnabled
        };
        nightReminder.Click += (_, _) =>
        {
            _nightRestReminderEnabled = nightReminder.IsChecked;
            SaveSettings();
        };
        var weatherGreeting = new MenuItem
        {
            Header = "当地天气问候（系统位置）",
            IsCheckable = true,
            IsChecked = _weatherGreetingEnabled
        };
        weatherGreeting.Click += async (_, _) =>
        {
            _weatherGreetingEnabled = weatherGreeting.IsChecked;
            SaveSettings();
            if (_weatherGreetingEnabled)
                await RefreshWeatherGreetingAsync(true);
        };
        var refreshWeather = new MenuItem
        {
            Header = "重新获取当地位置",
            IsEnabled = _weatherGreetingEnabled
        };
        refreshWeather.Click += async (_, _) => await RefreshWeatherGreetingAsync(true);
        var randomSpeech = new MenuItem
        {
            Header = "随机说话",
            IsCheckable = true,
            IsChecked = _randomSpeechEnabled
        };
        randomSpeech.Click += (_, _) =>
        {
            _randomSpeechEnabled = randomSpeech.IsChecked;
            ScheduleNextRandomSpeech();
            SaveSettings();
        };
        var speechInterval = new MenuItem
        {
            Header = $"说话间隔（{_randomSpeechIntervalMinutes} 分钟）",
            IsEnabled = _randomSpeechEnabled
        };
        foreach (var minutes in new[] { 1, 5, 10, 15, 30, 60 })
            speechInterval.Items.Add(CreateSpeechIntervalMenuItem(minutes));
        greetingSettings.Items.Add(timeGreeting);
        greetingSettings.Items.Add(mealReminder);
        greetingSettings.Items.Add(nightReminder);
        greetingSettings.Items.Add(weatherGreeting);
        greetingSettings.Items.Add(refreshWeather);
        greetingSettings.Items.Add(new Separator());
        greetingSettings.Items.Add(randomSpeech);
        greetingSettings.Items.Add(speechInterval);

        var soundSettings = new MenuItem { Header = "触摸音效" };
        var touchSound = new MenuItem
        {
            Header = "人物触摸音效",
            IsCheckable = true,
            IsChecked = _touchSoundEnabled
        };
        touchSound.Click += (_, _) =>
        {
            _touchSoundEnabled = touchSound.IsChecked;
            SaveSettings();
        };
        var soundSource = new MenuItem
        {
            Header = $"音效来源（{(_touchSoundSource == "custom" ? "自定义" : "默认")}）"
        };
        var defaultSound = new MenuItem
        {
            Header = "默认音效",
            IsCheckable = true,
            IsChecked = _touchSoundSource == "default"
        };
        defaultSound.Click += (_, _) =>
        {
            _touchSoundSource = "default";
            SaveSettings();
        };
        var customSound = new MenuItem
        {
            Header = _customTouchSoundPath is null
                ? "自定义音效（尚未导入）"
                : $"自定义音效（{Path.GetFileName(_customTouchSoundPath)}）",
            IsCheckable = true,
            IsChecked = _touchSoundSource == "custom",
            IsEnabled = _customTouchSoundPath is not null
        };
        customSound.Click += (_, _) =>
        {
            _touchSoundSource = "custom";
            SaveSettings();
        };
        soundSource.Items.Add(defaultSound);
        soundSource.Items.Add(customSound);

        var importSound = new MenuItem { Header = "导入自定义音效" };
        importSound.Click += (_, _) => ImportTouchSound();
        var previewSound = new MenuItem { Header = "试听当前音效" };
        previewSound.Click += (_, _) => PlayTouchSound(true);
        var restoreSound = new MenuItem
        {
            Header = "恢复默认音效",
            IsEnabled = _customTouchSoundPath is not null
        };
        restoreSound.Click += (_, _) => RestoreDefaultTouchSound();
        var soundVolume = new MenuItem
        {
            Header = $"触摸音效音量（{_touchSoundVolume:P0}）"
        };
        foreach (var volume in new[] { 0d, 0.25, 0.35, 0.5, 0.75, 1d })
            soundVolume.Items.Add(CreateSoundVolumeMenuItem(volume));
        soundSettings.Items.Add(touchSound);
        soundSettings.Items.Add(soundSource);
        soundSettings.Items.Add(importSound);
        soundSettings.Items.Add(previewSound);
        soundSettings.Items.Add(restoreSound);
        soundSettings.Items.Add(soundVolume);

        var snap = new MenuItem { Header = "拖动后贴边", IsCheckable = true, IsChecked = _snapToEdge };
        snap.Click += (_, _) =>
        {
            _snapToEdge = snap.IsChecked;
            SaveSettings();
        };

        var characters = new MenuItem { Header = "角色" };
        characters.Items.Add(CreateCharacterMenuItem(AliyaCharacter));
        characters.Items.Add(CreateCharacterMenuItem(WindyCharacter));

        var topmost = new MenuItem { Header = "始终置顶", IsCheckable = true, IsChecked = Topmost };
        topmost.Click += (_, _) =>
        {
            Topmost = topmost.IsChecked;
            SaveSettings();
        };

        var sizes = new MenuItem { Header = "尺寸" };
        sizes.Items.Add(CreateSizeMenuItem("超小", 160));
        sizes.Items.Add(CreateSizeMenuItem("小", 220));
        sizes.Items.Add(CreateSizeMenuItem("标准", 300));
        sizes.Items.Add(CreateSizeMenuItem("大", 390));
        sizes.Items.Add(CreateSizeMenuItem("超大", 520));

        var resetPosition = new MenuItem { Header = "回到右下角" };
        resetPosition.Click += async (_, _) =>
        {
            var area = SystemParameters.WorkArea;
            var (_, maxLeft) = GetHorizontalBounds();
            var targetLeft = maxLeft - 20;
            var targetTop = area.Bottom - Height - 10;
            await Task.WhenAll(
                AnimateAsync(this, LeftProperty, Left, targetLeft, 220, new QuadraticEase { EasingMode = EasingMode.EaseOut }),
                AnimateAsync(this, TopProperty, Top, targetTop, 220, new QuadraticEase { EasingMode = EasingMode.EaseOut }));
            Left = targetLeft;
            Top = targetTop;
            BeginAnimation(LeftProperty, null);
            BeginAnimation(TopProperty, null);
            SaveSettings();
        };

        var exit = new MenuItem { Header = "退出" };
        exit.Click += (_, _) => Close();

        menu.Items.Add(running);
        menu.Items.Add(new Separator());
        menu.Items.Add(talk);
        menu.Items.Add(actions);
        menu.Items.Add(new Separator());
        menu.Items.Add(autoActions);
        menu.Items.Add(greetingSettings);
        menu.Items.Add(soundSettings);
        menu.Items.Add(snap);
        menu.Items.Add(characters);
        menu.Items.Add(topmost);
        menu.Items.Add(new Separator());
        menu.Items.Add(sizes);
        menu.Items.Add(resetPosition);
        menu.Items.Add(new Separator());
        menu.Items.Add(CreateRendererModeMenu());
        menu.Items.Add(CreateLookAtMenuItem());
        menu.Items.Add(CreateGazeSettingsMenu());
        menu.Items.Add(new Separator());
        menu.Items.Add(exit);
        menu.IsOpen = true;

        await Task.CompletedTask;
        e.Handled = true;
    }

    private MenuItem CreateActionMenuItem(string title, Func<Task> action)
    {
        var item = new MenuItem { Header = title };
        item.Click += async (_, _) => await action();
        return item;
    }

    private MenuItem CreateSizeMenuItem(string title, double width)
    {
        var item = new MenuItem { Header = title };
        item.Click += (_, _) => SetPetSize(width);
        return item;
    }

    private MenuItem CreateSpeechIntervalMenuItem(int minutes)
    {
        var item = new MenuItem
        {
            Header = $"{minutes} 分钟",
            IsCheckable = true,
            IsChecked = _randomSpeechIntervalMinutes == minutes
        };
        item.Click += (_, _) =>
        {
            _randomSpeechIntervalMinutes = minutes;
            ScheduleNextRandomSpeech();
            SaveSettings();
        };
        return item;
    }

    private MenuItem CreateSoundVolumeMenuItem(double volume)
    {
        var item = new MenuItem
        {
            Header = $"{volume:P0}",
            IsCheckable = true,
            IsChecked = Math.Abs(_touchSoundVolume - volume) < 0.001
        };
        item.Click += (_, _) =>
        {
            _touchSoundVolume = volume;
            SaveSettings();
            PlayTouchSound(true);
        };
        return item;
    }

    private MenuItem CreateCharacterMenuItem(string character)
    {
        var item = new MenuItem
        {
            Header = character,
            IsCheckable = true,
            IsChecked = _character == character
        };
        item.Click += (_, _) => SetCharacter(character);
        return item;
    }

    private PetSettings LoadSettings()
    {
        try
        {
            if (!File.Exists(_settingsPath))
                return new PetSettings();

            return JsonSerializer.Deserialize<PetSettings>(File.ReadAllText(_settingsPath))
                   ?? new PetSettings();
        }
        catch
        {
            return new PetSettings();
        }
    }

    private void SaveSettings()
    {
        try
        {
            var settings = new PetSettings
            {
                LayoutVersion = CurrentLayoutVersion,
                Left = Left,
                Top = Top,
                Width = Width,
                Height = Height,
                Topmost = Topmost,
                PetRunning = _petRunning,
                AutoActions = _autoActions,
                SnapToEdge = _snapToEdge,
                TimeGreetingEnabled = _timeGreetingEnabled,
                MealReminderEnabled = _mealReminderEnabled,
                NightRestReminderEnabled = _nightRestReminderEnabled,
                WeatherGreetingEnabled = _weatherGreetingEnabled,
                RandomSpeechEnabled = _randomSpeechEnabled,
                RandomSpeechIntervalMinutes = _randomSpeechIntervalMinutes,
                Character = _character,
                TouchSoundEnabled = _touchSoundEnabled,
                TouchSoundSource = _touchSoundSource,
                CustomTouchSoundPath = _customTouchSoundPath,
                TouchSoundVolume = _touchSoundVolume,
                LastGreetingKey = _lastGreetingKey,
                LastWeatherGreetingDate = _lastWeatherGreetingDate,
                CharacterRendererMode = _rendererMode == CharacterRenderMode.Live2D ? "live2d" : "existing",
                Live2DLookAtEnabled = _lookAtEnabled,
                GazeFollowMode = _gazeFollowMode == GazeFollowMode.Global ? "global" : "nearby",
GazeSpeedMultiplier = _gazeSpeed,
                PhysicsStrength = _physicsStrength,
                Live2DPhysicsOutputAmplitude = _physicsOutputAmplitude,
                GazeIdleTimeoutSeconds = _gazeIdleTimeoutSeconds,
                Live2DGazeHeadFollowAmount = _gazeHeadFollowAmount,
            };
            File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // 设置保存失败不应影响宠物运行。
        }
    }

    private static double Clamp(double value, double min, double max)
    {
        return Math.Max(min, Math.Min(max, value));
    }
}








