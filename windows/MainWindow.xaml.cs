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
using AliyaPet.Rendering;
using Windows.Devices.Geolocation;

namespace AliyaPet;

public partial class MainWindow : Window
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
    private readonly DispatcherTimer _idleTimer;
    private readonly DispatcherTimer _speechTimer;
    private readonly DispatcherTimer _randomSpeechTimer;
    private readonly DispatcherTimer _greetingTimer;
    private readonly DispatcherTimer _hoverHideTimer;
    private readonly DispatcherTimer _autoActionTimer;
    private readonly DispatcherTimer _blinkTimer;
    private readonly DispatcherTimer _openEyesTimer;
    private readonly Random _random = new();
    private readonly Queue<string> _aliyaClickBag = new();
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

    private readonly string[] _generalPhrases =
    {
        "今天也要认真工作呀。",
        "COSMOS 正在待命。",
        "要记得休息一下。",
        "我会一直陪着你。",
        "点击我会做随机动作。",
        "双击可以改变大小。",
        "拖动后我会贴近屏幕边缘。",
        "桌面宠物已连接。",
        "任务完成后也要休息一下。",
        "要不要一起发会儿呆？"
    };
    private readonly string[] _aliyaClickPhrases;
    private readonly Dictionary<GreetingPeriod, string[]> _timeGreetingPhrases;

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
        _aliyaClickPhrases = LoadAliyaClickPhrases();
        _timeGreetingPhrases = LoadTimeGreetingPhrases();

        Loaded += MainWindow_Loaded;
        Closing += (_, _) =>
        {
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
                SpeakGeneralRandom();
            ScheduleNextRandomSpeech();
        };

        _greetingTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _greetingTimer.Tick += async (_, _) => await CheckScheduledGreetingAsync();

        _hoverHideTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(220) };
        _hoverHideTimer.Tick += (_, _) =>
        {
            _hoverHideTimer.Stop();
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
        _rendererMode = settings.CharacterRendererMode == "live2d"
            ? CharacterRenderMode.Live2D
            : CharacterRenderMode.Existing;
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

        // 启动后按设置激活初始渲染模式（等布局完成）
        Dispatcher.BeginInvoke(async () => await ApplyInitialRendererModeAsync());

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
        Speak($"已切换为 {_character}。");
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
        var period = GetGreetingPeriod(now);
        var day = period == GreetingPeriod.LateNight && now.Hour < 2
            ? now.Date.AddDays(-1)
            : now.Date;
        var key = $"{day:yyyy-MM-dd}:{period}";
        if (_lastGreetingKey == key)
            return;

        var timeGreetingAllowed = _timeGreetingEnabled
                                  && (period is not GreetingPeriod.Lunch
                                      and not GreetingPeriod.Dinner || _mealReminderEnabled)
                                  && (period is not GreetingPeriod.LateNight
                                      and not GreetingPeriod.DeepNight || _nightRestReminderEnabled);
        var weatherAvailable = _weatherGreetingEnabled
                               && _weatherGreeting is not null
                               && _lastWeatherGreetingDate != now.ToString("yyyy-MM-dd");
        string? message = null;

        if (timeGreetingAllowed)
        {
            var reminderPeriod = period is GreetingPeriod.Lunch
                or GreetingPeriod.Dinner
                or GreetingPeriod.LateNight
                or GreetingPeriod.DeepNight;
            if (!reminderPeriod && weatherAvailable && _random.NextDouble() < 0.35)
            {
                message = _weatherGreeting;
                _lastWeatherGreetingDate = now.ToString("yyyy-MM-dd");
            }
            else
            {
                message = GetTimeGreeting(period);
            }
        }
        else if (weatherAvailable)
        {
            message = _weatherGreeting;
            _lastWeatherGreetingDate = now.ToString("yyyy-MM-dd");
        }

        if (message is null)
            return;

        _lastGreetingKey = key;
        Speak(message);
        SaveSettings();
    }

    private enum GreetingPeriod
    {
        Morning,
        Forenoon,
        Lunch,
        Afternoon,
        Dinner,
        Evening,
        LateNight,
        DeepNight
    }

    private static GreetingPeriod GetGreetingPeriod(DateTime time)
    {
        var minutes = time.Hour * 60 + time.Minute;
        if (minutes is >= 300 and <= 569) return GreetingPeriod.Morning;
        if (minutes is >= 570 and <= 689) return GreetingPeriod.Forenoon;
        if (minutes is >= 690 and <= 810) return GreetingPeriod.Lunch;
        if (minutes is >= 811 and <= 1049) return GreetingPeriod.Afternoon;
        if (minutes is >= 1050 and <= 1200) return GreetingPeriod.Dinner;
        if (minutes is >= 1201 and <= 1349) return GreetingPeriod.Evening;
        return minutes >= 1350 || minutes <= 119
            ? GreetingPeriod.LateNight
            : GreetingPeriod.DeepNight;
    }

    private string GetTimeGreeting(GreetingPeriod period)
    {
        if (_timeGreetingPhrases.TryGetValue(period, out var phrases)
            && phrases.Length > 0)
            return phrases[_random.Next(phrases.Length)];

        return period switch
        {
            GreetingPeriod.Morning => "早上好，新的一天也一起加油吧。",
            GreetingPeriod.Forenoon => "上午好，忙碌时也记得喝点水。",
            GreetingPeriod.Lunch => "到午饭时间了，先好好吃饭吧。",
            GreetingPeriod.Afternoon => "下午好，累了就休息几分钟。",
            GreetingPeriod.Dinner => "晚饭时间到了，别忙到忘记吃饭。",
            GreetingPeriod.Evening => "晚上好，今天也辛苦了。",
            GreetingPeriod.LateNight => "已经很晚了，早点休息吧。",
            _ => "夜深了，先放下工作好好睡一觉吧。"
        };
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

    private void SpeakGeneralRandom()
    {
        Speak(_generalPhrases[_random.Next(_generalPhrases.Length)]);
    }

    private void SpeakClickRandom()
    {
        if (_character != AliyaCharacter || _aliyaClickPhrases.Length == 0)
        {
            SpeakGeneralRandom();
            return;
        }

        if (_aliyaClickBag.Count == 0)
        {
            foreach (var phrase in _aliyaClickPhrases.OrderBy(_ => _random.Next()))
                _aliyaClickBag.Enqueue(phrase);
        }
        Speak(_aliyaClickBag.Dequeue());
    }

    private static string[] LoadAliyaClickPhrases()
    {
        try
        {
            var path = Path.Combine(
                AppContext.BaseDirectory,
                "Assets",
                "dialogue",
                "user_click.json");
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var phrases = new List<string>();
            foreach (var entry in document.RootElement.GetProperty("entries").EnumerateArray())
            {
                if (entry.TryGetProperty("enabled", out var enabled)
                    && enabled.ValueKind == JsonValueKind.False)
                    continue;

                var text = entry.GetProperty("text").GetString();
                if (!string.IsNullOrWhiteSpace(text))
                    phrases.Add(text.Replace("\\", Environment.NewLine));
            }
            return phrases.ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    private static Dictionary<GreetingPeriod, string[]> LoadTimeGreetingPhrases()
    {
        var result = new Dictionary<GreetingPeriod, string[]>();
        foreach (var period in Enum.GetValues<GreetingPeriod>())
        {
            try
            {
                var path = Path.Combine(
                    AppContext.BaseDirectory,
                    "Assets",
                    "dialogue",
                    "time",
                    GetGreetingPeriodFileName(period) + ".json");
                using var document = JsonDocument.Parse(File.ReadAllText(path));
                var phrases = new List<string>();
                foreach (var entry in document.RootElement.GetProperty("entries").EnumerateArray())
                {
                    if (entry.TryGetProperty("enabled", out var enabled)
                        && enabled.ValueKind == JsonValueKind.False)
                        continue;

                    var text = entry.GetProperty("text").GetString();
                    if (!string.IsNullOrWhiteSpace(text))
                        phrases.Add(text);
                }
                result[period] = phrases.ToArray();
            }
            catch
            {
                result[period] = Array.Empty<string>();
            }
        }
        return result;
    }

    private static string GetGreetingPeriodFileName(GreetingPeriod period)
    {
        return period switch
        {
            GreetingPeriod.Morning => "morning",
            GreetingPeriod.Forenoon => "forenoon",
            GreetingPeriod.Lunch => "lunch",
            GreetingPeriod.Afternoon => "afternoon",
            GreetingPeriod.Dinner => "dinner",
            GreetingPeriod.Evening => "evening",
            GreetingPeriod.LateNight => "late_night",
            _ => "deep_night"
        };
    }

    private void Speak(string text)
    {
        SpeechText.Text = text;
        if (_rendererMode == CharacterRenderMode.Live2D)
            _live2D?.SetLipSyncValue(0.7);
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

    private void PetImage_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
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

    private async void PetImage_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
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
        ShowQuickActions();
    }

    private void PetImage_MouseLeave(object sender, MouseEventArgs e)
    {
        ScheduleQuickActionsHide();
    }

    private void HoverQuickActions_MouseEnter(object sender, MouseEventArgs e)
    {
        _hoverHideTimer.Stop();
    }

    private void HoverQuickActions_MouseLeave(object sender, MouseEventArgs e)
    {
        ScheduleQuickActionsHide();
    }

    private void ShowQuickActions()
    {
        _hoverHideTimer.Stop();
        HoverQuickActionsPopup.PlacementTarget = GetActivePetVisual();
        if (HoverQuickActionsPopup.IsOpen)
            return;

        HoverQuickActionsPopup.HorizontalOffset =
            (GetActivePetVisual().ActualWidth - HoverQuickActions.Width) / 2;
        HoverQuickActionsPopup.IsOpen = true;
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

    private void ScheduleQuickActionsHide()
    {
        _hoverHideTimer.Stop();
        _hoverHideTimer.Start();
    }

    private void HideQuickActions()
    {
        HoverQuickActions.BeginAnimation(OpacityProperty, null);
        HoverQuickActionsTranslate.BeginAnimation(TranslateTransform.YProperty, null);
        HoverQuickActionsPopup.IsOpen = false;
        HoverQuickActions.IsHitTestVisible = false;
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
        SpeakClickRandom();
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
        talk.Click += (_, _) => SpeakClickRandom();

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






