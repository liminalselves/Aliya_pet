using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AliyaPet.Rendering;

namespace AliyaPet;

public partial class MainWindow : Window
{
    private const double DragThreshold = 5;
    private const int ActionFrameDurationMilliseconds = 160;
    private const int IdleFrameDurationMilliseconds = 1200;
    private const string AliyaCharacter = "Aliya";
    private const string WindyCharacter = "Windy";
    private const string MultiFrameMode = "MultiFrame";
    private const string Live2DMode = "Live2D";
    private readonly DispatcherTimer _idleTimer;
    private readonly DispatcherTimer _speechTimer;
    private readonly DispatcherTimer _autoActionTimer;
    private readonly DispatcherTimer _frameTimer;
    private readonly DispatcherTimer _clickTimer;
    private readonly DispatcherTimer _longPressTimer;
    private readonly List<BitmapSource> _frames = [];
    private readonly Random _random = new();
    private readonly string _settingsPath;

    private bool _dragging;
    private bool _pointerMoved;
    private bool _actionRunning;
    private bool _autoActions = true;
    private bool _snapToEdge = true;
    private bool _mirrored;
    private int _frameIndex;
    private string _character = AliyaCharacter;
    private string _rendererMode = MultiFrameMode;
    private bool _live2DLookAtEnabled = true;
    private bool _lookTargetCentered = true;
    private bool _switchingRenderer;
    private Live2DCharacterRenderer? _live2DRenderer;
    private Point _mouseStart;
    private Point _lastMouse;
    private double _leftStart;
    private double _topStart;
    private double _phase;
    private bool _longPressTriggered;

    private readonly string[] _phrases =
    {
        "今天也要认真工作呀。",
        "COSMOS 正在待命。",
        "要记得休息一下。",
        "我会一直待在桌面上。",
        "点击我会做随机动作。",
        "滚动鼠标滚轮可以调整大小。",
        "右键可以选择动作。",
        "桌面宠物已连接到桌面。",
        "任务完成后，也要奖励自己一下。",
        "需要我陪你一起发呆吗？"
    };

    private sealed class PetSettings
    {
        public PetSettings() { }

        public double Left { get; set; } = double.NaN;
        public double Top { get; set; } = double.NaN;
        public double Width { get; set; } = 300;
        public double Height { get; set; } = 470;
        public bool Topmost { get; set; } = true;
        public bool AutoActions { get; set; } = true;
        public bool SnapToEdge { get; set; } = true;
        public bool Mirrored { get; set; }
        public string Character { get; set; } = AliyaCharacter;
        public string CharacterRendererMode { get; set; } = MultiFrameMode;
        public bool Live2DLookAtEnabled { get; set; } = true;
    }

    public MainWindow()
    {
        InitializeComponent();

        var settingsDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AliyaDesktopPet.MultiFrame");
        Directory.CreateDirectory(settingsDirectory);
        _settingsPath = Path.Combine(settingsDirectory, "settings.json");

        Loaded += MainWindow_Loaded;
        Closing += (_, _) =>
        {
            _live2DRenderer?.Dispose();
            SaveSettings();
        };

        _idleTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        _idleTimer.Tick += (_, _) => UpdateIdleAnimation();
        _idleTimer.Start();

        _speechTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3.2) };
        _speechTimer.Tick += (_, _) =>
        {
            SpeechBubble.Visibility = Visibility.Collapsed;
            _live2DRenderer?.SetSpeaking(false);
            _speechTimer.Stop();
        };

        _frameTimer = new DispatcherTimer();
        _frameTimer.Tick += (_, _) =>
        {
            if (_dragging || _frames.Count < 2)
                return;

            _frameIndex = (_frameIndex + 1) % _frames.Count;
            PetImage.Source = _frames[_frameIndex];
            _frameTimer.Interval = GetFrameInterval();
        };

        _clickTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(320)
        };
        _clickTimer.Tick += async (_, _) =>
        {
            _clickTimer.Stop();
            _live2DRenderer?.TriggerClick();
            await PlayRandomActionAsync(true);
        };

        _longPressTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.2) };
        _longPressTimer.Tick += (_, _) =>
        {
            _longPressTimer.Stop();
            if (_dragging && !_pointerMoved)
            {
                _longPressTriggered = true;
                Close();
            }
        };

        _autoActionTimer = new DispatcherTimer();
        _autoActionTimer.Tick += async (_, _) =>
        {
            _autoActionTimer.Stop();
            if (_autoActions && !_dragging && !_actionRunning)
                await PlayRandomActionAsync(false);
            ScheduleNextAutoAction();
        };

        SourceInitialized += (_, _) =>
        {
            if (PresentationSource.FromVisual(this) is HwndSource source)
                source.AddHook(WindowHitTestHook);
        };
    }

    private IntPtr WindowHitTestHook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WmNcHitTest = 0x0084;
        const int HtTransparent = -1;
        if (message != WmNcHitTest || SpeechBubble.Visibility == Visibility.Visible)
            return IntPtr.Zero;

        var packed = lParam.ToInt64();
        var screenPoint = new Point((short)(packed & 0xffff), (short)((packed >> 16) & 0xffff));
        var localPoint = PetSurface.PointFromScreen(screenPoint);
        var horizontalPadding = PetSurface.ActualWidth * 0.1;
        var verticalPadding = PetSurface.ActualHeight * 0.03;
        var insideCharacter = localPoint.X >= horizontalPadding
                              && localPoint.X <= PetSurface.ActualWidth - horizontalPadding
                              && localPoint.Y >= verticalPadding
                              && localPoint.Y <= PetSurface.ActualHeight;
        if (!insideCharacter)
        {
            handled = true;
            return new IntPtr(HtTransparent);
        }

        return IntPtr.Zero;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var settings = LoadSettings();
        Width = Clamp(settings.Width, 180, 450);
        Height = Clamp(settings.Height, 285, 705);
        Topmost = settings.Topmost;
        _autoActions = settings.AutoActions;
        _snapToEdge = settings.SnapToEdge;
        _mirrored = settings.Mirrored;
        _live2DLookAtEnabled = settings.Live2DLookAtEnabled;
        _character = NormalizeCharacter(settings.Character);
        LoadFrames();
        ApplyMirror();

        if (double.IsFinite(settings.Left) && double.IsFinite(settings.Top))
        {
            Left = settings.Left;
            Top = settings.Top;
        }
        else
        {
            Left = SystemParameters.WorkArea.Right - Width - 30;
            Top = SystemParameters.WorkArea.Bottom - Height - 20;
        }

        ClampToWorkArea();
        ScheduleNextAutoAction();

        if (settings.CharacterRendererMode == Live2DMode && _character == AliyaCharacter)
            await SetRendererModeAsync(Live2DMode, false);
    }

    private void LoadFrames()
    {
        _frameTimer.Stop();
        _frames.Clear();
        _frameIndex = 0;

        var characterDirectory = Path.Combine(AppContext.BaseDirectory, "Frames", _character);
        var idleDirectory = Path.Combine(characterDirectory, "idle");
        var frameDirectory = Directory.Exists(idleDirectory) ? idleDirectory : characterDirectory;
        if (Directory.Exists(frameDirectory))
        {
            foreach (var file in Directory.EnumerateFiles(frameDirectory, "*.png")
                         .OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.UriSource = new Uri(file, UriKind.Absolute);
                image.EndInit();
                image.Freeze();
                _frames.Add(image);
            }
        }

        if (_frames.Count == 0)
        {
            var prefix = _character == WindyCharacter ? "windy" : "aliya";
            _frames.Add(new BitmapImage(new Uri($"/Assets/{prefix}_pet.png", UriKind.Relative)));
            _frames.Add(new BitmapImage(new Uri($"/Assets/{prefix}_pet_blink.png", UriKind.Relative)));
        }

        PetImage.Source = _frames[0];
        _frameTimer.Interval = GetFrameInterval();
        _frameTimer.Start();
    }

    private TimeSpan GetFrameInterval()
    {
        var milliseconds = _frameIndex == 0
            ? IdleFrameDurationMilliseconds
            : ActionFrameDurationMilliseconds;
        return TimeSpan.FromMilliseconds(milliseconds);
    }

    private async Task SetRendererModeAsync(string mode, bool announce = true)
    {
        mode = mode == Live2DMode ? Live2DMode : MultiFrameMode;
        if (_switchingRenderer || mode == _rendererMode)
            return;

        if (mode == Live2DMode && _character != AliyaCharacter)
        {
            if (announce)
                Speak("Live2D 当前仅支持 Aliya。");
            return;
        }

        _switchingRenderer = true;
        try
        {
            if (mode == MultiFrameMode)
            {
                ReleaseLive2DRenderer();
                _rendererMode = MultiFrameMode;
                PetImage.Visibility = Visibility.Visible;
                Live2DHost.Visibility = Visibility.Collapsed;
                _frameTimer.Start();
                if (announce)
                    Speak("已切换为多帧模式。");
                SaveSettings();
                return;
            }

            _frameTimer.Stop();
            var renderer = new Live2DCharacterRenderer();
            var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler readyHandler = (_, _) => ready.TrySetResult(true);
            EventHandler<string> failedHandler = (_, _) => ready.TrySetResult(false);
            renderer.Ready += readyHandler;
            renderer.LoadFailed += failedHandler;
            _live2DRenderer = renderer;
            Live2DHost.Children.Add(renderer);
            Live2DHost.Visibility = Visibility.Visible;

            await renderer.InitializeAsync();
            var loaded = await ready.Task;
            renderer.Ready -= readyHandler;
            renderer.LoadFailed -= failedHandler;

            if (!loaded || _live2DRenderer != renderer)
            {
                ReleaseLive2DRenderer();
                _rendererMode = MultiFrameMode;
                PetImage.Visibility = Visibility.Visible;
                Live2DHost.Visibility = Visibility.Collapsed;
                _frameTimer.Start();
                Speak("Live2D 加载失败，已自动回退到多帧模式。");
                SaveSettings();
                return;
            }

            renderer.LoadFailed += Live2DRenderer_LoadFailed;
            _rendererMode = Live2DMode;
            PetImage.Visibility = Visibility.Collapsed;
            _lookTargetCentered = false;
            UpdateLive2DLookAt();
            if (announce)
                Speak("已切换为 Live2D 模式。");
            SaveSettings();
        }
        finally
        {
            _switchingRenderer = false;
        }
    }

    private async void Live2DRenderer_LoadFailed(object? sender, string message)
    {
        if (_rendererMode != Live2DMode || _switchingRenderer)
            return;

        await SetRendererModeAsync(MultiFrameMode, false);
        Speak($"Live2D 渲染异常，已回退：{message}");
    }

    private void ReleaseLive2DRenderer()
    {
        if (_live2DRenderer is null)
            return;

        _live2DRenderer.LoadFailed -= Live2DRenderer_LoadFailed;
        Live2DHost.Children.Remove(_live2DRenderer);
        _live2DRenderer.Dispose();
        _live2DRenderer = null;
    }

    private void UpdateLive2DLookAt()
    {
        if (_rendererMode != Live2DMode || _live2DRenderer?.IsReady != true)
            return;

        if (!_live2DLookAtEnabled)
        {
            if (!_lookTargetCentered)
            {
                _live2DRenderer.SetLookTarget(0, 0);
                _lookTargetCentered = true;
            }
            return;
        }

        if (_dragging || PetSurface.ActualWidth <= 0 || PetSurface.ActualHeight <= 0)
            return;

        var pointer = Mouse.GetPosition(PetSurface);
        var x = (pointer.X / PetSurface.ActualWidth - 0.5) * 2;
        var y = (0.5 - pointer.Y / PetSurface.ActualHeight) * 2;
        if (Math.Abs(x) > 2.5 || Math.Abs(y) > 2.5)
        {
            x = 0;
            y = 0;
        }

        _live2DRenderer.SetLookTarget(Clamp(x, -1, 1), Clamp(y, -1, 1));
        _lookTargetCentered = Math.Abs(x) < 0.01 && Math.Abs(y) < 0.01;
    }

    private void SetCharacter(string character)
    {
        character = NormalizeCharacter(character);
        if (_character == character)
            return;

        _character = character;
        if (_character != AliyaCharacter && _rendererMode == Live2DMode)
            _ = SetRendererModeAsync(MultiFrameMode, false);
        LoadFrames();
        SaveSettings();
        Speak($"已切换为 {_character}。");
    }

    private static string NormalizeCharacter(string? character)
    {
        return character == WindyCharacter ? WindyCharacter : AliyaCharacter;
    }

    private void UpdateIdleAnimation()
    {
        UpdateLive2DLookAt();
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
        if (!_autoActions)
            return;

        _autoActionTimer.Interval = TimeSpan.FromSeconds(_random.Next(8, 16));
        _autoActionTimer.Start();
    }

    private void SpeakRandom()
    {
        Speak(_phrases[_random.Next(_phrases.Length)]);
    }

    private void Speak(string text)
    {
        SpeechText.Text = text;
        SpeechBubble.Visibility = Visibility.Visible;
        _live2DRenderer?.SetSpeaking(true);
        _speechTimer.Stop();
        _speechTimer.Start();
    }

    private async Task PlayRandomActionAsync(bool speak)
    {
        var action = _random.Next(6);
        if (speak)
            SpeakRandom();

        switch (action)
        {
            case 0: await HopAsync(); break;
            case 1: await SwayAsync(); break;
            case 2: await ShakeAsync(); break;
            case 3: await StretchAsync(); break;
            case 4: await NodAsync(); break;
            default: await WalkAsync(); break;
        }
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
        var workArea = SystemParameters.WorkArea;
        var availableLeft = Left - workArea.Left;
        var availableRight = workArea.Right - (Left + Width);
        var direction = availableRight >= 100 || availableRight >= availableLeft ? 1 : -1;
        var distance = Math.Min(140, direction > 0 ? availableRight : availableLeft);

        if (distance < 28)
        {
            await HopCoreAsync();
            return;
        }

        ActionScale.ScaleX = _mirrored ? -1 : 1;
        var targetLeft = Left + direction * distance;
        var verticalOffset = _random.Next(-70, 71);
        var targetTop = Clamp(Top + verticalOffset, workArea.Top, Math.Max(workArea.Top, workArea.Bottom - Height));
        var windowMove = Task.WhenAll(
            AnimateAsync(this, LeftProperty, Left, targetLeft, 900, new SineEase { EasingMode = EasingMode.EaseInOut }),
            AnimateAsync(this, TopProperty, Top, targetTop, 900, new SineEase { EasingMode = EasingMode.EaseInOut }));

        for (var i = 0; i < 5; i++)
        {
            await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, 0, -8, 80);
            await AnimateAsync(ActionTranslate, TranslateTransform.YProperty, -8, 0, 80);
        }

        await windowMove;
        Left = targetLeft;
        Top = targetTop;
        BeginAnimation(LeftProperty, null);
        BeginAnimation(TopProperty, null);
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

        ActionScale.ScaleX = _mirrored ? -1 : 1;
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

    private void ApplyMirror()
    {
        ActionScale.ScaleX = _mirrored ? -1 : 1;
    }

    private void PetImage_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (_actionRunning)
            return;

        _dragging = true;
        _pointerMoved = false;
        _longPressTriggered = false;
        _mouseStart = GetPointerScreenPosition(e);
        _lastMouse = _mouseStart;
        _leftStart = Left;
        _topStart = Top;
        _autoActionTimer.Stop();
        _frameTimer.Stop();
        _frameIndex = 0;
        PetImage.Source = _frames[0];
        PetSurface.CaptureMouse();
        _longPressTimer.Stop();
        _longPressTimer.Start();
        e.Handled = true;
    }

    private void PetImage_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_dragging || e.LeftButton != MouseButtonState.Pressed)
            return;

        var current = GetPointerScreenPosition(e);
        var deltaX = current.X - _mouseStart.X;
        var deltaY = current.Y - _mouseStart.Y;
        if (Math.Abs(deltaX) > DragThreshold || Math.Abs(deltaY) > DragThreshold)
        {
            _pointerMoved = true;
            _longPressTimer.Stop();
        }

        Left = _leftStart + deltaX;
        Top = _topStart + deltaY;

        var frameDx = current.X - _lastMouse.X;
        ActionRotate.Angle = Clamp(frameDx * 1.4, -12, 12);
        if (_live2DLookAtEnabled)
        {
            var frameDy = current.Y - _lastMouse.Y;
            _live2DRenderer?.SetLookTarget(
                Clamp(frameDx / 18, -1, 1),
                Clamp(-frameDy / 18, -1, 1));
            _lookTargetCentered = false;
        }
        _lastMouse = current;
    }

    private Point GetPointerScreenPosition(MouseEventArgs e)
    {
        var screenPixels = PointToScreen(e.GetPosition(this));
        var source = PresentationSource.FromVisual(this);
        return source?.CompositionTarget is { } target
            ? target.TransformFromDevice.Transform(screenPixels)
            : screenPixels;
    }

    private async void PetImage_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (!_dragging)
            return;

        _dragging = false;
        _longPressTimer.Stop();
        PetSurface.ReleaseMouseCapture();
        ActionRotate.Angle = 0;
        _frameTimer.Interval = GetFrameInterval();
        _frameTimer.Start();

        if (_pointerMoved)
        {
            if (_snapToEdge)
                await SnapToNearestEdgeAsync();
            else
                ClampToWorkArea();
            SaveSettings();
        }
        else if (!_longPressTriggered)
        {
            if (_clickTimer.IsEnabled)
            {
                _clickTimer.Stop();
                CyclePetSize();
            }
            else
            {
                _clickTimer.Start();
            }
        }

        if (_live2DLookAtEnabled)
            _live2DRenderer?.SetLookTarget(0, 0);

        ScheduleNextAutoAction();
        e.Handled = true;
    }

    private void PetImage_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        var factor = e.Delta > 0 ? 1.08 : 0.92;
        SetPetSize(Width * factor);
        e.Handled = true;
    }

    private void SetPetSize(double width)
    {
        var oldBottom = Top + Height;
        Width = Clamp(width, 180, 450);
        Height = Width * 470 / 300;
        Top = oldBottom - Height;
        ClampToWorkArea();
        SaveSettings();
    }

    private void CyclePetSize()
    {
        var nextWidth = Width < 260 ? 300 : Width < 345 ? 390 : 220;
        SetPetSize(nextWidth);
        Speak(nextWidth switch
        {
            220 => "已切换为小尺寸。",
            300 => "已切换为标准尺寸。",
            _ => "已切换为大尺寸。"
        });
    }

    private async Task SnapToNearestEdgeAsync()
    {
        ClampToWorkArea();
        var workArea = SystemParameters.WorkArea;
        var target = (Left + Width / 2) < (workArea.Left + workArea.Width / 2)
            ? workArea.Left
            : workArea.Right - Width;

        var start = Left;
        await AnimateAsync(this, LeftProperty, start, target, 180, new QuadraticEase { EasingMode = EasingMode.EaseOut });
        Left = target;
        BeginAnimation(LeftProperty, null);
    }

    private void ClampToWorkArea()
    {
        var area = SystemParameters.WorkArea;
        Left = Clamp(Left, area.Left, Math.Max(area.Left, area.Right - Width));
        Top = Clamp(Top, area.Top, Math.Max(area.Top, area.Bottom - Height));
    }

    private async void PetImage_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        var menu = new ContextMenu();

        var talk = new MenuItem { Header = "说句话" };
        talk.Click += (_, _) => SpeakRandom();

        var actions = new MenuItem { Header = "动作" };
        actions.Items.Add(CreateActionMenuItem("跳一下", HopAsync));
        actions.Items.Add(CreateActionMenuItem("左右摇摆", SwayAsync));
        actions.Items.Add(CreateActionMenuItem("抖一抖", ShakeAsync));
        actions.Items.Add(CreateActionMenuItem("伸懒腰", StretchAsync));
        actions.Items.Add(CreateActionMenuItem("点头", NodAsync));
        actions.Items.Add(CreateActionMenuItem("走几步", WalkAsync));
        actions.Items.Add(new Separator());
        actions.Items.Add(CreateActionMenuItem("随机动作", () => PlayRandomActionAsync(false)));

        var autoActions = new MenuItem { Header = "自动随机动作", IsCheckable = true, IsChecked = _autoActions };
        autoActions.Click += (_, _) =>
        {
            _autoActions = autoActions.IsChecked;
            ScheduleNextAutoAction();
            SaveSettings();
        };

        var snap = new MenuItem { Header = "拖动后贴边", IsCheckable = true, IsChecked = _snapToEdge };
        snap.Click += (_, _) =>
        {
            _snapToEdge = snap.IsChecked;
            SaveSettings();
        };

        var mirror = new MenuItem { Header = "镜像角色", IsCheckable = true, IsChecked = _mirrored };
        mirror.Click += (_, _) =>
        {
            _mirrored = mirror.IsChecked;
            ApplyMirror();
            SaveSettings();
        };

        var characters = new MenuItem { Header = "角色" };
        characters.Items.Add(CreateCharacterMenuItem(AliyaCharacter));
        characters.Items.Add(CreateCharacterMenuItem(WindyCharacter));

        var rendererMode = new MenuItem { Header = "人物渲染模式" };
        var multiFrame = new MenuItem
        {
            Header = "多帧模式",
            IsCheckable = true,
            IsChecked = _rendererMode == MultiFrameMode
        };
        multiFrame.Click += async (_, _) => await SetRendererModeAsync(MultiFrameMode);
        var live2D = new MenuItem
        {
            Header = "Live2D 模式",
            IsCheckable = true,
            IsChecked = _rendererMode == Live2DMode,
            IsEnabled = _character == AliyaCharacter
        };
        live2D.Click += async (_, _) => await SetRendererModeAsync(Live2DMode);
        rendererMode.Items.Add(multiFrame);
        rendererMode.Items.Add(live2D);

        var lookAt = new MenuItem
        {
            Header = _rendererMode == Live2DMode ? "视线跟随" : "视线跟随（仅适用于 Live2D）",
            IsCheckable = true,
            IsChecked = _live2DLookAtEnabled,
            IsEnabled = _rendererMode == Live2DMode
        };
        lookAt.Click += (_, _) =>
        {
            _live2DLookAtEnabled = lookAt.IsChecked;
            _lookTargetCentered = false;
            UpdateLive2DLookAt();
            SaveSettings();
        };

        var topmost = new MenuItem { Header = "始终置顶", IsCheckable = true, IsChecked = Topmost };
        topmost.Click += (_, _) =>
        {
            Topmost = topmost.IsChecked;
            SaveSettings();
        };

        var sizes = new MenuItem { Header = "尺寸" };
        sizes.Items.Add(CreateSizeMenuItem("小", 220));
        sizes.Items.Add(CreateSizeMenuItem("标准", 300));
        sizes.Items.Add(CreateSizeMenuItem("大", 390));

        var resetPosition = new MenuItem { Header = "回到右下角" };
        resetPosition.Click += async (_, _) =>
        {
            var area = SystemParameters.WorkArea;
            var targetLeft = area.Right - Width - 20;
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

        menu.Items.Add(talk);
        menu.Items.Add(actions);
        menu.Items.Add(new Separator());
        menu.Items.Add(autoActions);
        menu.Items.Add(snap);
        menu.Items.Add(mirror);
        menu.Items.Add(characters);
        menu.Items.Add(rendererMode);
        menu.Items.Add(lookAt);
        menu.Items.Add(topmost);
        menu.Items.Add(new Separator());
        menu.Items.Add(sizes);
        menu.Items.Add(resetPosition);
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
                Left = Left,
                Top = Top,
                Width = Width,
                Height = Height,
                Topmost = Topmost,
                AutoActions = _autoActions,
                SnapToEdge = _snapToEdge,
                Mirrored = _mirrored,
                Character = _character,
                CharacterRendererMode = _rendererMode,
                Live2DLookAtEnabled = _live2DLookAtEnabled
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
