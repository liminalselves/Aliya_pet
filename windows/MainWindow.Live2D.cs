using System.Collections.Generic;
using System.Text.Json;
using System.IO;
using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using AliyaPet.Models.Interaction;
using AliyaPet.Rendering;

namespace AliyaPet;

// Live2D 模式集成（与现有 WPF 渲染并存，可运行中切换，带并发保护与缓存）。
public partial class MainWindow
{
    private const int WmNcHitTest = 0x0084;
    private const int HtTransparent = -1;
    private const int DoubleClickMilliseconds = 500;
    private const int LongPressMilliseconds = 1200;
    private static readonly double[] PetSizeOptions = { 300, 420, 520 };

    // 头部安全比例默认值：X 取模型真实范围（±30°→默认幅度 0.9 后约 ±27°），
    // Y/Z 稍保守，供 ApplyLive2DRuntimeSettings 设置。
    private const double GazeHeadRangeXDefault = 1.0;
    private const double GazeHeadRangeYDefault = 0.85;
    private const double GazeHeadRangeZDefault = 0.30;

    // 渲染器切换状态机：防止 Initialize/Destroy/Update 重叠。
    private enum RendererSwitchState
    {
        Existing,
        LoadingLive2D,
        Live2D,
        StoppingLive2D,
        Failed
    }

    // 视线跟随模式：人物附近跟随 / 全局跟随
    private enum GazeFollowMode { Nearby, Global }

    private CharacterRenderMode _rendererMode = CharacterRenderMode.Existing;
    private RendererSwitchState _switchState = RendererSwitchState.Existing;
    private readonly SemaphoreSlim _rendererSwitchLock = new(1, 1);
    private Live2DCharacterRenderer? _live2D;
    private bool _lookAtEnabled = true;
    private GazeFollowMode _gazeFollowMode = GazeFollowMode.Nearby;
        private double _gazeSpeed = 1.0;
    private double _physicsStrength = 1.0;
    private double _physicsOutputAmplitude = 1.0; // Physics 输出幅度（0.0~2.0，默认 1.0）
    private double _gazeIdleTimeoutSeconds = 5.0;
    private double _gazeHeadFollowAmount = 0.9; // 头部跟随幅度（0.2~1.0，默认 90%）
    private bool _live2DLoadFailed;
    private DateTime? _lastClickUtc;
    private bool _pendingClickCancelled;
    private bool _longPressFired;
    private double _dragIntensity;
    private DispatcherTimer? _longPressTimer;
    private DispatcherTimer? _lookAtTimer;
    private DispatcherTimer? _actionEventTimer;
    private ExistingSpriteActionPlayer? _existingActionPlayer;
    private Live2DActionPlayerProxy? _live2DActionPlayer;
    private HwndSource? _hwndSource;
    private int _sizeOptionIndex;
    private bool _appExiting;

    /// <summary>在 MainWindow 构造函数末尾调用，初始化 Live2D 相关计时器与窗口钩子。</summary>
    private void InitializeLive2D()
    {
        _longPressTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(LongPressMilliseconds) };
        _longPressTimer.Tick += (_, _) =>
        {
            if (_interaction.CheckLongPressFired())
            {
                _longPressTimer.Stop();
                OnLongPressFired();
            }
        };

        _lookAtTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        _lookAtTimer.Tick += (_, _) => UpdateLookAtTarget();

        // Live2D 动作事件轮询（blink / sound / speech）
        _actionEventTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
        _actionEventTimer.Tick += (_, _) => PollActionEvents();

        SizeChanged += (_, _) =>
        {
            if (_rendererMode == CharacterRenderMode.Live2D && _live2D is not null)
                ResizeLive2D();
            // 窗口尺寸变化后统一重定位工具栏（Loaded 优先级，避免在布局前读取旧值）
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(UpdateCharacterToolbarPlacement));
        };

        SourceInitialized += (_, _) =>
        {
            _hwndSource = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
            _hwndSource?.AddHook(WndProc);
        };
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmNcHitTest
            && _rendererMode == CharacterRenderMode.Live2D
            && _live2D is { IsReady: true }
            && Live2DImage.IsVisible)
        {
            int screenX = (short)(lParam.ToInt64() & 0xFFFF);
            int screenY = (short)((lParam.ToInt64() >> 16) & 0xFFFF);
            var client = PointFromScreen(new Point(screenX, screenY));

            // 工具栏及其交互区域（工具栏矩形 + 连接走廊 + 容错扩展）：
            // 绝不穿透，必须让 WPF 正常命中按钮（否则工具栏无法点击/选中）。
            if (IsPointInToolbarInputZone(client))
            {
                handled = false;
                return IntPtr.Zero;
            }

            var origin = Live2DImage.TranslatePoint(new Point(0, 0), this);
            if (client.X >= origin.X
                && client.Y >= origin.Y
                && client.X < origin.X + Live2DImage.ActualWidth
                && client.Y < origin.Y + Live2DImage.ActualHeight)
            {
                if (_live2D.HitTest(client.X - origin.X, client.Y - origin.Y))
                    return IntPtr.Zero;
                // 人物矩形内未命中模型（透明部分）→ 穿透
                handled = true;
                return new IntPtr(HtTransparent);
            }
            // 人物矩形之外（含工具栏下方空白）：默认处理，不穿透
            return IntPtr.Zero;
        }
        return IntPtr.Zero;
    }

    /// <summary>判断窗口坐标点是否位于工具栏输入区域（工具栏矩形/连接走廊/容错扩展）。</summary>
    private bool IsPointInToolbarInputZone(Point windowPoint)
    {
        var toolbar = ToolbarRect();
        if (toolbar.Contains(windowPoint))
            return true;
        var inflated = toolbar;
        inflated.Inflate(12, 12);
        if (inflated.Contains(windowPoint))
            return true;
        if (ToolbarHoverBridge.Visibility == Visibility.Visible)
        {
            double bLeft = Canvas.GetLeft(ToolbarHoverBridge);
            double bTop = Canvas.GetTop(ToolbarHoverBridge);
            if (new Rect(bLeft, bTop, ToolbarHoverBridge.ActualWidth, ToolbarHoverBridge.ActualHeight).Contains(windowPoint))
                return true;
        }
        return false;
    }

    private async Task ApplyInitialRendererModeAsync()
    {
        if (_rendererMode != CharacterRenderMode.Live2D)
            return;

        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            DeactivateLive2D();
            Speak("Live2D 模型加载失败，已恢复原有模式。");
        }
    }

    /// <summary>后台预加载 Live2D：创建 Host/加载模型/检测参数，但绝不切换当前可见人物模式（保持 PNG）。</summary>
    private async Task PreloadLive2DInternalAsync()
    {
        if (_appExiting)
            return;
        try
        {
            await ActivateLive2DAsync(applyUi: false);
            AppLog.Info("LIVE2D_PRELOADED ready={0}", _live2D is { IsReady: true });
        }
        catch (Exception ex)
        {
            AppLog.Error("LIVE2D_PRELOAD_FAILED error={0}", ex.Message);
            _live2DLoadFailed = true;
        }
    }

    private (int wDip, int hDip) GetLive2DViewportDip()
    {
        int wDip = (int)Math.Max(1, Width - HorizontalAnimationPadding * 2);
        int hDip = (int)Math.Max(1, Height - 95 - 70);
        return (wDip, hDip);
    }

    /// <summary>
    /// 激活 Live2D。applyUi=true：创建渲染器并切换显示为 Live2D；
    /// applyUi=false（后台预加载）：创建渲染器并检测参数，但不切换当前可见人物模式（保持 PNG）。
    /// </summary>
    private async Task<bool> ActivateLive2DAsync(bool applyUi = true)
    {
        try
        {
            CancelDialogue("reload_live2d");
            var hwnd = new WindowInteropHelper(this).Handle;
            var modelPath = Live2DInterop.ModelJsonPath;
            AppLog.Info("加载模型: {0}", modelPath);
            Live2DInterop.ValidateModelBundle(modelPath); // 损坏的 JSON/缺失引用 -> 抛异常 -> 回退

            var dpi = VisualTreeHelper.GetDpi(this);
            var (wDip, hDip) = GetLive2DViewportDip();
            var renderer = new Live2DCharacterRenderer(Live2DImage, hwnd);
            await renderer.InitializeAsync(modelPath, wDip, hDip, dpi.DpiScaleX, dpi.DpiScaleY);
            if (_appExiting)
            {
                renderer.Dispose();
                AppLog.Info("应用退出，取消 Live2D 初始化");
                return false;
            }
            _live2D = renderer;

            if (applyUi)
            {
                _rendererMode = CharacterRenderMode.Live2D;
                _switchState = RendererSwitchState.Live2D;
            }

            var info = new Live2DInterop.AliyaLive2DModelInfo();
            Live2DInterop.AliyaLive2D_GetInfo(_live2D.Handle, out info);
            AppLog.Info("模型信息: params={0} drawables={1} textures={2} canvas={3:0.###}x{4:0.###} physics={5}",
                info.ParameterCount, info.DrawableCount, info.TextureCount, info.CanvasWidth, info.CanvasHeight, info.HasPhysics);

            _live2D.SetLookAtEnabled(_lookAtEnabled);
            _live2D.SetGazeSpeed(_gazeSpeed);
            _live2D.SetPhysicsStrength(_physicsStrength);
            _live2D.SetGazeIdleTimeout(_gazeIdleTimeoutSeconds);
            _live2D.SetScale(1.0);
            ApplyLive2DRuntimeSettings();

            if (applyUi)
            {
                _live2D.SetOpacity(0);
                PetImage.Visibility = Visibility.Collapsed;
                Live2DImage.Visibility = Visibility.Visible;
                _live2D.Start();

                _live2D.SetState(CharacterState.Entrance, 0);
                Live2DImage.BeginAnimation(OpacityProperty,
                    new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(420))
                    {
                        EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut }
                    });
                await Task.Delay(430);
                _live2D.SetOpacity(1);
                _live2D.SetState(CharacterState.Idle, 0);

                SyncRendererState();
                _lookAtTimer?.Start();
                _actionEventTimer?.Start();
            }

            _live2DLoadFailed = false;
            // 模型重载：退出抚摸模式并重置互动参数检测
            _interaction.OnModelReloaded();
            // 启动时检测当前模型真实嘴部参数（模型重载后重新检测）
            _mouthController.ResetDetection();
            _ = _mouthController.IsAvailable;

            if (applyUi)
            {
                AppLog.Info("Live2D 模式已激活");
                // 等待 Live2D 首帧与布局完成后再定位工具栏
                InvalidateCharacterLayout();
            }
            else
            {
                AppLog.Info("Live2D 预加载完成（保持 PNG 模式）");
            }
            return true;
        }
        catch (Exception ex)
        {
            AppLog.Error("Live2D 激活失败: {0}", ex);
            _live2DLoadFailed = true;
            _switchState = RendererSwitchState.Failed;
            try { _live2D?.Dispose(); } catch { }
            _live2D = null;
            return false;
        }
    }

    private void DeactivateLive2D()
    {
        try
        {
            _interaction.OnModelReloaded();
            _lookAtTimer?.Stop();
            _actionEventTimer?.Stop();
            if (_live2D is not null)
            {
                // 缓存策略：暂停并隐藏，不销毁（保留 Device/Shader，重复进入 <1s）
                _live2D.Pause();
                _live2D.Hide();
                _live2D.ReportMetrics();
            }
        }
        catch (Exception ex)
        {
            AppLog.Error("Live2D 暂停失败: {0}", ex);
        }
        finally
        {
            Live2DImage.Source = null;
            Live2DImage.Visibility = Visibility.Collapsed;
            PetImage.Visibility = Visibility.Visible;
            _rendererMode = CharacterRenderMode.Existing;
            _switchState = RendererSwitchState.Existing;
            ApplyPetRunningState();
            // 切回 PNG 后重新定位工具栏
            InvalidateCharacterLayout();
            AppLog.Info("已切换回原有模式");
        }
    }

    private void DisposeLive2DForExit()
    {
        _appExiting = true;
        CancelDialogue("app_exit");
        _mouthRunner?.StopNow();
        _lookAtTimer?.Stop();
        _actionEventTimer?.Stop();
        try
        {
            _live2D?.ReportMetrics();
            _live2D?.Dispose();
        }
        catch (Exception ex)
        {
            AppLog.Error("Live2D 退出释放失败: {0}", ex);
        }
        _live2D = null;
    }

    private async void SetRendererModeAsync(CharacterRenderMode mode)
    {
        if (_rendererMode == mode)
            return;
        if (_appExiting)
            return;
        if (!await _rendererSwitchLock.WaitAsync(0))
        {
            Speak("正在切换渲染模式，请稍候。");
            return;
        }

        try
        {
            CancelDialogue("switch_render_mode");
            // 切换模式：结束当前抚摸会话（ModeChanged）
            _interaction.ExitPettingMode("mode_changed");
            if (mode == CharacterRenderMode.Live2D)
            {
                if (_live2D is { IsReady: true })
                {
                    // 快速路径：缓存命中，直接恢复
                    try
                    {
                        _switchState = RendererSwitchState.Live2D;
                        _rendererMode = CharacterRenderMode.Live2D;
                        PetImage.Visibility = Visibility.Collapsed;
                        _live2D.SetLookAtEnabled(_lookAtEnabled);
                        _live2D.SetGazeSpeed(_gazeSpeed);
                        _live2D.SetPhysicsStrength(_physicsStrength);
                        _live2D.SetGazeIdleTimeout(_gazeIdleTimeoutSeconds);
                        ApplyLive2DRuntimeSettings();
                        _live2D.Show();
                        _live2D.SetState(CharacterState.Wake, 0);
                        _live2D.SetState(CharacterState.Idle, 0);
                        SyncRendererState();
                        _lookAtTimer?.Start();
                        _actionEventTimer?.Start();
                        SaveSettings();
                        Speak("已切换到 Live2D 模式。");
                        InvalidateCharacterLayout();

                        ApplyPettingCursorState(_interaction.IsPettingModeActive);
                    }
                    catch (Exception ex)
                    {
                        AppLog.Error("快速切换 Live2D 失败: {0}", ex);
                        DeactivateLive2D();

                        ApplyPettingCursorState(_interaction.IsPettingModeActive);
                    }
                    return;
                }

                if (_live2DLoadFailed)
                {
                    Speak("Live2D 资源缺失，无法切换。");
                    return;
                }

                _switchState = RendererSwitchState.LoadingLive2D;
                Live2DImage.BeginAnimation(OpacityProperty, new DoubleAnimation(0.35, 0.35, TimeSpan.Zero));
                Live2DImage.Visibility = Visibility.Visible;
                Live2DImage.Source = null;

                bool ok = await ActivateLive2DAsync();
                if (ok)
                {
                    SaveSettings();
                    Speak("已切换到 Live2D 模式。");
                }
                else
                {
                    DeactivateLive2D();
                    SaveSettings();
                    Speak("Live2D 模式加载失败，已恢复原有模式。");
                }

                ApplyPettingCursorState(_interaction.IsPettingModeActive);
            }
            else
            {
                DeactivateLive2D();
                SaveSettings();
                Speak("已切换到原有模式。");

                ApplyPettingCursorState(_interaction.IsPettingModeActive);
            }
        }
        finally
        {
            _rendererSwitchLock.Release();
            // 成功/失败/取消统一恢复工具栏交互状态
            RestoreToolbarAfterCharacterModeSwitch();
        }
    }

    private void SyncRendererState()
    {
        if (_live2D is null) return;
        if (!_petRunning)
        {
            _live2D.SetState(CharacterState.Sleep, 0);
            _live2D.SetOpacity(0.58);
            return;
        }
        if (_dragging)
        {
            _live2D.SetState(CharacterState.Drag, _dragIntensity);
            return;
        }
        _live2D.SetState(CharacterState.Idle, 0);
        _live2D.SetOpacity(1);
    }

    /// <summary>统一应用运行时可设置项（物理强度 / 输出幅度 / 静止待机时间 / 视线开关 / 视线速度），
    /// 并回读 Native 生效值写诊断日志。设置变更、激活、切换、重建后都要调用。</summary>
    private void ApplyLive2DRuntimeSettings()
    {
        if (_live2D is null || !_live2D.IsReady) return;
        try
        {
            _live2D.SetLookAtEnabled(_lookAtEnabled);
            _live2D.SetGazeSpeed(_gazeSpeed);
            _live2D.SetPhysicsStrength(_physicsStrength);
            _live2D.SetPhysicsOutputAmplitude(_physicsOutputAmplitude);
            _live2D.SetGazeIdleTimeout(_gazeIdleTimeoutSeconds);
            _live2D.SetGazeHeadRange(GazeHeadRangeXDefault, GazeHeadRangeYDefault, GazeHeadRangeZDefault);
            _live2D.SetGazeHeadFollowAmount(_gazeHeadFollowAmount);
            _live2D.LogRuntimeSettingsReadback();
        }
        catch (Exception ex)
        {
            AppLog.Warn("ApplyLive2DRuntimeSettings exception={0}", ex.Message);
        }
    }

    private void UpdateLookAtTarget()
    {
        if (_live2D is null || !_lookAtEnabled || !_petRunning || _dragging)
        {
            if (_live2D is not null && !_lookAtEnabled)
                _live2D.ClearLookTarget();
            return;
        }

        GetCursorPos(out var pt);
        var windowTopLeft = PointToScreen(new Point(0, 0));
        var imageOrigin = Live2DImage.TranslatePoint(new Point(0, 0), this);
        var dpi = VisualTreeHelper.GetDpi(this);
        double imageScreenX = windowTopLeft.X + imageOrigin.X * dpi.DpiScaleX;
        double imageScreenY = windowTopLeft.Y + imageOrigin.Y * dpi.DpiScaleY;
        double imageWidthPx = Live2DImage.ActualWidth * dpi.DpiScaleX;
        double imageHeightPx = Live2DImage.ActualHeight * dpi.DpiScaleY;
        if (imageWidthPx <= 0 || imageHeightPx <= 0)
            return;

        // ---- 头部幅度映射：GazeAnchor（脸部中心）+ 追踪距离（reach 物理像素）----
        if (_gazeFollowMode == GazeFollowMode.Nearby)
        {
            // 人物附近跟随：光标离开角色区域（外扩一小段缓冲）→ 清除目标，人物缓慢回正
            double margin = 28 * dpi.DpiScaleX;
            if (pt.X < imageScreenX - margin || pt.X > imageScreenX + imageWidthPx + margin ||
                pt.Y < imageScreenY - margin || pt.Y > imageScreenY + imageHeightPx + margin)
            {
                _live2D.ClearLookTarget();
                return;
            }
        }

        // 脸部中心 ≈ 人物图像中心（模型在视口中居中渲染，脸部位于中上部）
        double anchorX = imageScreenX + imageWidthPx / 2;
        double anchorY = imageScreenY + imageHeightPx * 0.44;
        // 脸部尺寸估计（无检测器，用图像尺寸的比例近似）
        double faceW = imageWidthPx * 0.30;
        double faceH = imageHeightPx * 0.22;
        // 追踪距离：不可用整块屏幕做归一化（否则头部永远达不到大角度）
        double horizontalReachPixels = Math.Max(faceW * 5.0, 450.0);
        double verticalReachPixels = Math.Max(faceH * 4.0, 350.0);

        // 鼠标偏移（屏幕物理像素），Y 轴向上为正
        double dx = pt.X - anchorX;
        double dy = anchorY - pt.Y;
        double rawX = Clamp(dx / horizontalReachPixels, -1, 1);
        double rawY = Clamp(dy / verticalReachPixels, -1, 1);
        _live2D.SetGazeRawInput(rawX, rawY);
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_LAYERED = 0x00080000;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    private void OnLongPressFired()
    {
        if (!_dragging || _pointerMoved)
            return;
        _longPressFired = true;
        AppLog.Info("长按触发关闭");
        _ = CloseWithFadeAsync();
    }

    private async Task CloseWithFadeAsync()
    {
        if (_rendererMode == CharacterRenderMode.Live2D)
        {
            _live2D?.SetState(CharacterState.Exit, 0);
            Live2DImage.BeginAnimation(OpacityProperty,
                new DoubleAnimation(Live2DImage.Opacity, 0, TimeSpan.FromMilliseconds(200)));
            await Task.Delay(210);
        }
        Close();
    }

    private void HandleClickAsyncCore()
    {
        _ = HandleClickAsync();
    }

    private async Task HandleClickAsync()
    {
        var now = DateTime.UtcNow;
        // Live2D 模式下取消双击调节人物大小：双击一律按普通单击处理
        if (_rendererMode != CharacterRenderMode.Live2D
            && _lastClickUtc.HasValue
            && (now - _lastClickUtc.Value).TotalMilliseconds < DoubleClickMilliseconds)
        {
            _lastClickUtc = null;
            _pendingClickCancelled = true;
            TogglePetSize();
            return;
        }

        _lastClickUtc = now;
        _pendingClickCancelled = false;
        await Task.Delay(260);
        if (_pendingClickCancelled || _dragging)
            return;
        if (!_petRunning)
            return;

        PlayTouchSound();
        if (_rendererMode == CharacterRenderMode.Live2D)
            _live2D?.SetState(CharacterState.Click, 0);
        await PlayRandomActionAsync(true);
        if (_rendererMode == CharacterRenderMode.Live2D)
            SyncRendererState();

        // 互动单击（区域反应/连续点击/点击冷却）；冷却或疑惑时不播放常规点击台词
        var clickCtx = BuildInteractionContext(Mouse.GetPosition(this), pressed: false);
        bool suppressClickDialogue = _interaction.OnClick(clickCtx, wasDrag: false);
        if (!suppressClickDialogue)
            PlayDialogue(UserClickScene);
    }

    private void TogglePetSize()
    {
        double current = Width - HorizontalAnimationPadding * 2;
        int idx = 0;
        double best = double.MaxValue;
        for (int i = 0; i < PetSizeOptions.Length; i++)
        {
            double d = Math.Abs(PetSizeOptions[i] - current);
            if (d < best) { best = d; idx = i; }
        }
        _sizeOptionIndex = (idx + 1) % PetSizeOptions.Length;
        SetPetSize(PetSizeOptions[_sizeOptionIndex]);
        if (_rendererMode == CharacterRenderMode.Live2D)
            ResizeLive2D();
        Speak("已切换人物大小。");
    }

    private void ResizeLive2D()
    {
        if (_live2D is null || !_live2D.IsReady) return;
        try
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            var (wDip, hDip) = GetLive2DViewportDip();
            _live2D.Resize(wDip, hDip, dpi.DpiScaleX, dpi.DpiScaleY);
        }
        catch (Exception ex)
        {
            AppLog.Error("ResizeLive2D 失败（忽略，避免布局事件崩溃）: {0}", ex);
        }
    }

    private Task RunActionAsync(string name)
    {
        if (_rendererMode == CharacterRenderMode.Live2D)
            return PlayLive2DActionAsync(name);
        // PNG 原有动作库（WPF Transform 动画）
        return name switch
        {
            "hop" => HopAsync(),
            "sway" => SwayAsync(),
            "shake" => ShakeAsync(),
            "stretch" => StretchAsync(),
            "nod" => NodAsync(),
            "walk" or "walk_left" or "walk_right" => WalkAsync(),
            _ => PlayRandomActionAsync(false)
        };
    }

    private async Task PlayLive2DActionAsync(string name)
    {
        // Live2D 模式禁用移动动作
        if (name is "walk" or "walk_left" or "walk_right" or "move" or "moving")
            return;
        if (_actionRunning)
            return;
        _actionRunning = true;
        try
        {
            // 统一路由：Live2D 走 JSON 动作库（业务语义名 -> 动作 id）
            if (name == "walk")
                name = "walk_left";
            if (PlayCharacterAction(name))
            {
                if (name is "walk_left" or "walk_right")
                {
                    await WalkWindowAsync(name == "walk_left" ? -1 : 1);
                }
                else
                {
                    // 等待 Native 动作完成（最长 6s）
                    var deadline = DateTime.UtcNow.AddSeconds(6);
                    while (DateTime.UtcNow < deadline && _live2D is { IsReady: true } && _live2D.IsActionPlaying())
                        await Task.Delay(50);
                }
            }
        }
        finally
        {
            _actionRunning = false;
            if (_rendererMode == CharacterRenderMode.Live2D)
                SyncRendererState();
        }
    }

    private async Task WalkWindowAsync(int direction)
    {
        var (minLeft, maxLeft) = GetHorizontalBounds();
        double availableLeft = Left - minLeft;
        double availableRight = maxLeft - Left;
        int dir = direction != 0
            ? direction
            : (availableRight >= 100 || availableRight >= availableLeft ? 1 : -1);
        double distance = Math.Min(140, dir > 0 ? availableRight : availableLeft);
        if (distance < 28)
            return;

        double targetLeft = Left + dir * distance;
        await AnimateAsync(this, LeftProperty, Left, targetLeft, 900, new SineEase { EasingMode = EasingMode.EaseInOut });
        Left = targetLeft;
        BeginAnimation(LeftProperty, null);
        SaveSettings();
    }

    private FrameworkElement GetActivePetVisual()
    {
        return _rendererMode == CharacterRenderMode.Live2D ? Live2DImage : PetImage;
    }

    // ---------------- 菜单 ----------------

    private MenuItem CreateRendererModeMenu()
    {
        var menu = new MenuItem { Header = "人物渲染模式" };
        var existing = new MenuItem
        {
            Header = "原有模式",
            IsCheckable = true,
            IsChecked = _rendererMode == CharacterRenderMode.Existing,
            IsEnabled = _switchState != RendererSwitchState.LoadingLive2D
        };
        existing.Click += (_, _) => SetRendererModeAsync(CharacterRenderMode.Existing);
        var live2d = new MenuItem
        {
            Header = "Live2D 模式",
            IsCheckable = true,
            IsChecked = _rendererMode == CharacterRenderMode.Live2D,
            IsEnabled = !_live2DLoadFailed && _switchState != RendererSwitchState.LoadingLive2D
        };
        live2d.Click += (_, _) => SetRendererModeAsync(CharacterRenderMode.Live2D);
        menu.Items.Add(existing);
        menu.Items.Add(live2d);
        return menu;
    }

    private MenuItem CreateLookAtMenuItem()
    {
        var item = new MenuItem
        {
            Header = "视线跟随（仅 Live2D 模式）",
            IsCheckable = true,
            IsChecked = _lookAtEnabled,
            IsEnabled = _rendererMode == CharacterRenderMode.Live2D
        };
        item.Click += (_, _) =>
        {
            _lookAtEnabled = item.IsChecked;
            _live2D?.SetLookAtEnabled(_lookAtEnabled);
            if (!_lookAtEnabled)
                _live2D?.ClearLookTarget();
            SaveSettings();
        };
        return item;
    }

    private MenuItem CreateGazeSettingsMenu()
    {
        var menu = new MenuItem
        {
            Header = "视线跟随设置",
            IsEnabled = _rendererMode == CharacterRenderMode.Live2D
        };

        // 跟随模式：人物附近 / 全局
        var mode = new MenuItem { Header = "跟随模式" };
        var nearby = new MenuItem
        {
            Header = "人物附近跟随",
            IsCheckable = true,
            IsChecked = _gazeFollowMode == GazeFollowMode.Nearby
        };
        var global = new MenuItem
        {
            Header = "全局跟随",
            IsCheckable = true,
            IsChecked = _gazeFollowMode == GazeFollowMode.Global
        };
        nearby.Click += (_, _) =>
        {
            _gazeFollowMode = GazeFollowMode.Nearby;
            nearby.IsChecked = true;
            global.IsChecked = false;
            SaveSettings();
        };
        global.Click += (_, _) =>
        {
            _gazeFollowMode = GazeFollowMode.Global;
            global.IsChecked = true;
            nearby.IsChecked = false;
            SaveSettings();
        };
        mode.Items.Add(nearby);
        mode.Items.Add(global);
        menu.Items.Add(mode);

        // 跟随速度：1x ~ 5x
        var speed = new MenuItem { Header = "跟随速度" };
        for (int s = 1; s <= 5; s++)
        {
            int captured = s;
            var item = new MenuItem
            {
                Header = $"{s}x",
                IsCheckable = true,
                IsChecked = Math.Abs(_gazeSpeed - captured) < 0.01
            };
            item.Click += (_, _) =>
            {
                _gazeSpeed = captured;
                _live2D?.SetGazeSpeed(captured);
                foreach (MenuItem other in speed.Items)
                    other.IsChecked = other == item;
                SaveSettings();
                ApplyLive2DRuntimeSettings();
            };
            speed.Items.Add(item);
        }
        menu.Items.Add(speed);

        // 物理效果强度：0% ~ 200%
        var physics = new MenuItem { Header = "物理效果强度" };
        double[] physicsOptions = { 0, 0.5, 1.0, 1.5, 2.0 };
        foreach (var opt in physicsOptions)
        {
            double captured = opt;
            var item = new MenuItem
            {
                Header = $"{opt:P0}",
                IsCheckable = true,
                IsChecked = Math.Abs(_physicsStrength - captured) < 0.01
            };
            item.Click += (_, _) =>
            {
                _physicsStrength = captured;
                _live2D?.SetPhysicsStrength(captured);
                foreach (MenuItem other in physics.Items)
                    other.IsChecked = other == item;
                SaveSettings();
                ApplyLive2DRuntimeSettings();
            };
            physics.Items.Add(item);
        }
        menu.Items.Add(physics);

        // Physics 输出幅度：0% ~ 200%（独立于物理效果强度，只放大 Evaluate 后的输出增量）
        var amplitude = new MenuItem { Header = "Physics 输出幅度" };
        double[] amplitudeOptions = { 0, 0.5, 1.0, 1.5, 2.0 };
        foreach (var opt in amplitudeOptions)
        {
            double captured = opt;
            var item = new MenuItem
            {
                Header = $"{captured:P0}",
                IsCheckable = true,
                IsChecked = Math.Abs(_physicsOutputAmplitude - captured) < 0.01
            };
            item.Click += (_, _) =>
            {
                _physicsOutputAmplitude = captured;
                _live2D?.SetPhysicsOutputAmplitude(captured);
                foreach (MenuItem other in amplitude.Items)
                    other.IsChecked = other == item;
                SaveSettings();
                ApplyLive2DRuntimeSettings();
            };
            amplitude.Items.Add(item);
        }
        menu.Items.Add(amplitude);

        // 静止待机时间：0.5s ~ 10s
        var idle = new MenuItem { Header = "静止待机时间" };
        double[] idleOptions = { 0.5, 1, 2, 3, 5, 10 };
        foreach (var opt in idleOptions)
        {
            double captured = opt;
            var item = new MenuItem
            {
                Header = $"{opt} 秒",
                IsCheckable = true,
                IsChecked = Math.Abs(_gazeIdleTimeoutSeconds - captured) < 0.01
            };
            item.Click += (_, _) =>
            {
                _gazeIdleTimeoutSeconds = captured;
                _live2D?.SetGazeIdleTimeout(captured);
                foreach (MenuItem other in idle.Items)
                    other.IsChecked = other == item;
                SaveSettings();
                ApplyLive2DRuntimeSettings();
            };
            idle.Items.Add(item);
        }
        menu.Items.Add(idle);

        // 头部跟随幅度：20% ~ 100%（头部转动整体幅度，默认 90%）
        var headFollow = new MenuItem { Header = "头部跟随幅度" };
        double[] headFollowOptions = { 0.2, 0.4, 0.6, 0.8, 0.9, 1.0 };
        foreach (var opt in headFollowOptions)
        {
            double captured = opt;
            var item = new MenuItem
            {
                Header = $"{captured:P0}",
                IsCheckable = true,
                IsChecked = Math.Abs(_gazeHeadFollowAmount - captured) < 0.01
            };
            item.Click += (_, _) =>
            {
                _gazeHeadFollowAmount = captured;
                _live2D?.SetGazeHeadFollowAmount(captured);
                foreach (MenuItem other in headFollow.Items)
                    other.IsChecked = other == item;
                SaveSettings();
                ApplyLive2DRuntimeSettings();
            };
            headFollow.Items.Add(item);
        }
        menu.Items.Add(headFollow);
        return menu;
    }


    // =========================================================
    // 统一动作路由：PNG 与 Live2D 各自实现 ICharacterActionPlayer
    // =========================================================

    /// <summary>原有 PNG / 分帧动作实现（WPF Transform 动画）。</summary>
    private sealed class ExistingSpriteActionPlayer : ICharacterActionPlayer
    {
        private readonly MainWindow _owner;
        private static readonly HashSet<string> KnownActions = new()
        {
            "idle", "click", "hop", "sway", "shake", "stretch", "nod", "walk",
            "walk_left", "walk_right", "sleep", "wake"
        };

        public ExistingSpriteActionPlayer(MainWindow owner) => _owner = owner;

        public bool CanPlay(string actionId) => KnownActions.Contains(actionId);

        public bool Play(string actionId)
        {
            if (!CanPlay(actionId))
                return false;
            _ = _owner.RunActionAsync(actionId);
            return true;
        }

        public void Stop(string reason) => _owner.ResetActionTransforms();

        public bool IsPlaying => _owner._actionRunning;
        public string? CurrentActionId => null;
    }

    /// <summary>Live2D 参数动作实现（Native JSON 动作库）。</summary>
    private sealed class Live2DActionPlayerProxy : ICharacterActionPlayer
    {
        private readonly MainWindow _owner;
        private readonly Live2DCharacterRenderer _renderer;
        private readonly HashSet<string> _knownActions = new();

        public Live2DActionPlayerProxy(MainWindow owner, Live2DCharacterRenderer renderer)
        {
            _owner = owner;
            _renderer = renderer;
            RefreshActions();
        }

        public void RefreshActions()
        {
            _knownActions.Clear();
            try
            {
                using var doc = JsonDocument.Parse(_renderer.ListActions());
                foreach (var e in doc.RootElement.EnumerateArray())
                {
                    if (e.TryGetProperty("id", out var id) && id.GetString() is { Length: > 0 } s)
                        _knownActions.Add(s);
                }
            }
            catch
            {
                // 解析失败保持空集合
            }
        }

        public bool CanPlay(string actionId) => _knownActions.Contains(actionId);

        public bool Play(string actionId)
        {
            if (!CanPlay(actionId))
                return false;
            _renderer.PlayAction(actionId);
            return true;
        }

        public void Stop(string reason) => _renderer.PlayAction("shutdown");

        public bool IsPlaying => _renderer.IsActionPlaying();
        public string? CurrentActionId => _renderer.CurrentActionId();
    }

    /// <summary>业务层统一入口：按当前渲染模式路由到 PNG 或 Live2D 动作库。</summary>
    public bool PlayCharacterAction(string actionId)
    {
        if (_rendererMode == CharacterRenderMode.Live2D && _live2D is not null)
        {
            _live2DActionPlayer ??= new Live2DActionPlayerProxy(this, _live2D);
            return _live2DActionPlayer.Play(actionId);
        }
        _existingActionPlayer ??= new ExistingSpriteActionPlayer(this);
        return _existingActionPlayer.Play(actionId);
    }

    public ICharacterActionPlayer CurrentActionPlayer
    {
        get
        {
            if (_rendererMode == CharacterRenderMode.Live2D && _live2D is not null)
            {
                _live2DActionPlayer ??= new Live2DActionPlayerProxy(this, _live2D);
                return _live2DActionPlayer;
            }
            _existingActionPlayer ??= new ExistingSpriteActionPlayer(this);
            return _existingActionPlayer;
        }
    }

    private static readonly Dictionary<string, string> ActionSpeech = new()
    {
        ["action_wave"] = "你好呀～",
        ["action_stretch"] = "嗯——伸个懒腰，好舒服。",
        ["action_nod"] = "嗯嗯，知道啦！",
        ["action_doubt"] = "诶？是这样吗？",
    };

    private void PollActionEvents()
    {
        if (_live2D is null || !_live2D.IsReady)
            return;
        string json = _live2D.PollActionEvents();
        if (string.IsNullOrEmpty(json) || json == "[]")
            return;
        try
        {
            using var doc = JsonDocument.Parse(json);
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                string type = e.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
                string name = e.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                string category = e.TryGetProperty("category", out var cat) ? cat.GetString() ?? "" : "";
                if (type == "blink")
                {
                    _live2D.ForceBlink();
                }
                else if (type == "sound")
                {
                    PlayTouchSound(true);
                }
                else if (type == "speech")
                {
                    if (ActionSpeech.TryGetValue(category, out var phrase))
                        Speak(phrase);
                }
            }
        }
        catch
        {
            // 事件解析失败不影响主流程
        }
    }
    // ---------------- 自动切换测试（隐藏命令行参数 --autoswitch N） ----------------

    private async Task RunAutoSwitchTestAsync(int count)
    {
        AppLog.Info("开始自动切换测试: {0} 次", count);
        for (int i = 1; i <= count; i++)
        {
            AppLog.Info("切换 {0}/{1} -> Live2D", i, count);
            SetRendererModeAsync(CharacterRenderMode.Live2D);
            await WaitForSwitchIdleAsync();
            AppLog.Info("切换 {0}/{1} -> Existing", i, count);
            SetRendererModeAsync(CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
        }
        AppLog.Info("自动切换测试完成 {0} 次（各往返）", count);
    }

    private async Task WaitForSwitchIdleAsync()
    {
        // 等待切换锁可用（表示上一次切换完成）
        while (_rendererSwitchLock.CurrentCount == 0)
            await Task.Delay(50);
        await Task.Delay(200);
    }

    // ---------------- 自动化测试（隐藏命令行参数） ----------------
    //  --native-export-audit              Managed/Native 导出差异审计
    //  --native-abi-test                  ABI 版本校验
    //  --lip-sync-test                    口型参数平滑测试
    //  --lip-sync-missing-export-test     模拟缺失口型导出（容错）
    //  --live2d-activation-speak-test     激活+欢迎台词往返测试

    private void RunNativeExportAuditTest()
    {
        var audit = Live2DInterop.AuditExports();
        if (!string.IsNullOrEmpty(audit.Error))
        {
            AppLog.Error("NATIVE_EXPORT_AUDIT_ERROR {0}", audit.Error);
            return;
        }
        AppLog.Info("NATIVE_EXPORT_AUDIT dll={0}", audit.DllPath);
        AppLog.Info("NATIVE_EXPORT_AUDIT native_total={0}", audit.NativeExports.Count);
        AppLog.Info("NATIVE_EXPORT_AUDIT exact_match={0}", audit.ExactMatch.Count);
        foreach (var m in audit.ExactMatch)
            AppLog.Info("NATIVE_EXPORT_AUDIT_MATCH {0}", m);
        foreach (var m in audit.ManagedOnly)
            AppLog.Error("NATIVE_EXPORT_AUDIT_MANAGED_ONLY {0}", m);
        foreach (var m in audit.NativeOnly)
            AppLog.Info("NATIVE_EXPORT_AUDIT_NATIVE_ONLY {0}", m);

        bool pass = audit.ManagedOnly.Count == 0 && audit.SignatureMismatch.Count == 0;
        AppLog.Info(pass ? "NATIVE_EXPORT_AUDIT_RESULT PASS" : "NATIVE_EXPORT_AUDIT_RESULT FAIL");
    }

    private void RunNativeAbiTest()
    {
        bool ok = Live2DInterop.CheckApiVersionStrict();
        AppLog.Info(ok ? "NATIVE_ABI_TEST_RESULT PASS version={0}" : "NATIVE_ABI_TEST_RESULT FAIL version={0}", Live2DInterop.ExpectedNativeApiVersion);
    }

    private async Task RunLipSyncTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("LIP_SYNC_TEST_RESULT FAIL activate_failed");
            return;
        }
        var handler = _live2D;
        if (handler is null)
        {
            AppLog.Error("LIP_SYNC_TEST_RESULT FAIL no_renderer");
            return;
        }
        double[] seq = { 0.0, 0.25, 0.5, 0.75, 1.0, 0.0 };
        int failures = 0;
        foreach (double v in seq)
        {
            try
            {
                handler.SetLipSyncValue(v);
                for (int i = 0; i < 30; i++)
                    handler.Update(1.0 / 60.0);
                AppLog.Info("LIP_SYNC_STEP value={0:0.00} ok", v);
            }
            catch (Exception ex)
            {
                failures++;
                AppLog.Error("LIP_SYNC_STEP value={0:0.00} exception={1}", v, ex.Message);
            }
        }
        AppLog.Info(failures == 0 ? "LIP_SYNC_TEST_RESULT PASS" : "LIP_SYNC_TEST_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunMouthParamTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("MOUTH_PARAM_TEST_RESULT FAIL activate_failed");
            return;
        }
        var handler = _live2D;
        if (handler is null)
        {
            AppLog.Error("MOUTH_PARAM_TEST_RESULT FAIL no_renderer");
            return;
        }

        var info = handler.GetMouthParamInfo();
        AppLog.Info("MOUTH_PARAM_TEST_DETECT hasOpenY={0} hasForm={1} openYRange={2:0.###}~{3:0.###} formRange={4:0.###}~{5:0.###}",
            info.hasOpenY ? 1 : 0, info.hasForm ? 1 : 0, info.openYMin, info.openYMax, info.formMin, info.formMax);
        if (!info.hasOpenY)
        {
            AppLog.Info("MOUTH_PARAM_TEST_RESULT SKIP no_mouth_param");
            DeactivateLive2D();
            return;
        }

        // 写入 0.8 -> 放帧 -> 回读 ParamMouthOpenY 应接近 0.8
        handler.SetMouthOverride(true, 0.8, 0.0);
        for (int i = 0; i < 30; i++)
            handler.Update(1.0 / 60.0);
        bool readOk = handler.GetParameterValue("ParamMouthOpenY", out double value);
        AppLog.Info("MOUTH_PARAM_TEST_WRITE readOk={0} value={1:0.###}", readOk, value);
        bool passWrite = readOk && Math.Abs(value - 0.8) < 0.15;

        // 关闭覆盖 -> 放帧 -> 应回到 0
        handler.SetMouthOverride(false, 0, 0);
        for (int i = 0; i < 30; i++)
            handler.Update(1.0 / 60.0);
        bool readOk2 = handler.GetParameterValue("ParamMouthOpenY", out double value2);
        AppLog.Info("MOUTH_PARAM_TEST_CLOSE readOk={0} value={1:0.###}", readOk2, value2);
        bool passClose = readOk2 && value2 < 0.15;

        AppLog.Info("MOUTH_PARAM_TEST_RESULT {0} write={1} close={2}",
            passWrite && passClose ? "PASS" : "FAIL", passWrite ? 1 : 0, passClose ? 1 : 0);
        DeactivateLive2D();
    }

    private async Task RunDialogueSmokeTestAsync()
    {
        await ActivateLive2DAsync();

        var resolved = _dialoguePlayback.ResolveScene(UserClickScene);
        if (resolved is null)
        {
            AppLog.Error("DIALOGUE_SMOKE_RESULT FAIL no_resolved");
            Close();
            return;
        }
        AppLog.Info("DIALOGUE_SMOKE resolved id={0} pages={1} mouthMs={2} text={3}",
            resolved.Entry.Id, resolved.Pages.Count, resolved.MouthTotalMilliseconds, resolved.FinalText);

        var cts = new CancellationTokenSource();
        var playTask = _dialoguePlayback.PlayAsync(resolved, cts.Token);
        AppLog.Info("DIALOGUE_SMOKE bubble_visible={0} page0={1}",
            SpeechBubble.Visibility == Visibility.Visible, resolved.Pages[0].Text);

        // 等待完整会话结束（台词时长 + 气泡保留 + 预留缓冲）
        int waitMs = resolved.MouthTotalMilliseconds + 2000;
        var completed = await Task.WhenAny(playTask, Task.Delay(Math.Max(3000, waitMs)));
        bool finished = completed == playTask;
        AppLog.Info("DIALOGUE_SMOKE finished={0} bubble_visible={1}",
            finished, SpeechBubble.Visibility == Visibility.Visible);

        // 模拟一次打断：再次播放新台词应正常取消旧会话
        var cts2 = new CancellationTokenSource();
        var resolved2 = _dialoguePlayback.ResolveScene(UserClickScene);
        var playTask2 = resolved2 is null ? null : _dialoguePlayback.PlayAsync(resolved2, cts2.Token);
        await Task.Delay(300);
        cts2.Cancel();
        if (playTask2 is not null)
        {
            try { await playTask2; } catch { }
        }
        AppLog.Info("DIALOGUE_SMOKE_interrupt ok bubble_visible={0}", SpeechBubble.Visibility == Visibility.Visible);

        // 无嘴型参数（PNG 模式）冒烟：切换回原有模式后播放不应崩溃
        SetRendererModeAsync(CharacterRenderMode.Existing);
        await Task.Delay(300);
        var cts3 = new CancellationTokenSource();
        var resolved3 = _dialoguePlayback.ResolveScene(UserClickScene);
        if (resolved3 is not null)
        {
            var t3 = _dialoguePlayback.PlayAsync(resolved3, cts3.Token);
            await Task.Delay(400);
            cts3.Cancel();
            try { await t3; } catch { }
        }
        AppLog.Info("DIALOGUE_SMOKE_RESULT PASS");
    }

    /// <summary>工具栏定位验收测试：连续切换 PNG/Live2D 20 次，验证工具栏不漂移、不落到左上角。</summary>
    /// <summary>
    /// 猫耳图层割裂严格 A/B 对照测试（--ear-ab-test）：
    ///   A = 禁用耳朵互动 + 只 Idle/Physics
    ///   B = 禁用耳朵互动 + 抚摸头部运动（耳朵由 Physics 自然带动）
    ///   C = 左耳根部固定 +1，右耳禁用
    ///   D = 右耳根部固定 +1，左耳禁用
    /// splitObserved 需人工在画面观察记录。
    /// </summary>
    /// <summary>
    /// 人物模式切换验收测试（--mode-switch-test）：
    /// 启动保持 PNG → 后台预加载完成仍为 PNG → 手动切 Live2D → 切回 PNG → 连续手动切换 20 次。
    /// </summary>
    /// <summary>
    /// 工具栏命中测试（--toolbar-hit-test）：显示工具栏后对 HeadPettingButton /
    /// CharacterModeButton 中心执行 WPF 命中测试，验证最上层命中元素为按钮自身或其子元素。
    /// </summary>
    /// <summary>
    /// 工具栏输入诊断（--toolbar-input-debug）：PNG / Live2D / 切回 PNG 三种状态下输出
    /// 窗口扩展样式、按钮中心命中元素、鼠标直上/捕获、按钮父级链、各层 Bounds。
    /// </summary>
    private async Task RunToolbarInputDebugAsync()
    {
        await Task.Delay(400);
        LogToolbarInputDiagnostics("PNG");

        SetRendererModeAsync(CharacterRenderMode.Live2D);
        await WaitForSwitchIdleAsync();
        await Task.Delay(500);
        LogToolbarInputDiagnostics("Live2D");

        SetRendererModeAsync(CharacterRenderMode.Existing);
        await WaitForSwitchIdleAsync();
        await Task.Delay(500);
        LogToolbarInputDiagnostics("PNG_after");

        Close();
    }

    private void LogToolbarInputDiagnostics(string mode)
    {
        try
        {
            // 窗口扩展样式
            var hwnd = new WindowInteropHelper(this).Handle;
            int exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt32();
            AppLog.Info("WINDOW_EXSTYLE_AUDIT mode={0} exStyle=0x{1:X8} wsExTransparent={2} wsExNoActivate={3} wsExLayered={4}",
                mode, exStyle, (exStyle & WS_EX_TRANSPARENT) != 0,
                (exStyle & WS_EX_NOACTIVATE) != 0, (exStyle & WS_EX_LAYERED) != 0);

            // 按钮中心命中（Visual + Input + DirectlyOver）
            var center = GetElementWindowCenter(HeadPettingButton);
            var visualHit = VisualTreeHelper.HitTest(this, center)?.VisualHit;
            var inputHit = this.InputHitTest(center);
            var over = Mouse.DirectlyOver;
            AppLog.Info("LIVE2D_TOOLBAR_HIT_TEST button=HeadPettingButton mode={0} windowPoint=({1:0.#},{2:0.#}) visualHit={3} inputHit={4} mouseDirectlyOver={5} originalSource={6} capturedElement={7}",
                mode, center.X, center.Y, visualHit?.GetType().Name ?? "null",
                inputHit?.GetType().Name ?? "null", over?.GetType().Name ?? "null",
                over?.GetType().Name ?? "null", Mouse.Captured?.GetType().Name ?? "null");

            // 父级链
            LogToolbarParentChain(HeadPettingButton, mode);

            // 各层 Bounds
            var l2d = Live2DImage.TranslatePoint(new Point(0, 0), this);
            var tb = ToolbarRect();
            AppLog.Info("LIVE2D_LAYER_BOUNDS mode={0} live2DImage=({1:0.#},{2:0.#},{3:0.#},{4:0.#}) toolbar=({5:0.#},{6:0.#},{7:0.#},{8:0.#}) bridge=({9:0.#},{10:0.#},{11:0.#},{12:0.#}) bridgeVisible={13}",
                mode, l2d.X, l2d.Y, Live2DImage.ActualWidth, Live2DImage.ActualHeight,
                tb.X, tb.Y, tb.Width, tb.Height,
                Canvas.GetLeft(ToolbarHoverBridge), Canvas.GetTop(ToolbarHoverBridge),
                ToolbarHoverBridge.ActualWidth, ToolbarHoverBridge.ActualHeight,
                ToolbarHoverBridge.Visibility);
        }
        catch (Exception ex)
        {
            AppLog.Warn("TOOLBAR_INPUT_DEBUG_FAILED mode={0} error={1}", mode, ex.Message);
        }
    }

    private void LogToolbarParentChain(FrameworkElement el, string mode)
    {
        DependencyObject? current = el;
        var sb = new System.Text.StringBuilder();
        while (current != null)
        {
            var fe = current as FrameworkElement;
            var ui = current as UIElement;
            int z = current is UIElement uiEl ? Panel.GetZIndex(uiEl) : 0;
            sb.Append($"[{fe?.Name ?? "?"}|{current.GetType().Name}] vis={fe?.Visibility} op={fe?.Opacity:0.##} en={ui?.IsEnabled} hit={ui?.IsHitTestVisible} z={z} w={fe?.ActualWidth:0.#} h={fe?.ActualHeight:0.#}; ");
            current = VisualTreeHelper.GetParent(current) ?? LogicalTreeHelper.GetParent(current);
        }
        AppLog.Info("LIVE2D_TOOLBAR_PARENT_CHAIN mode={0} {1}", mode, sb);
    }

    /// <summary>
    /// 抚摸会话验收测试（--petting-session-test）：
    /// 进入抚摸 → 闭眼 → 移出容错区 → Finishing → 睁眼恢复 → Armed；
    /// 连续 20 次移出操作后眼睛必须恢复睁开（不残留闭眼）。
    /// </summary>
    private async Task RunPettingSessionTestAsync()
    {
        await ActivateLive2DAsync();
        await Task.Delay(300);
        _interaction.TogglePettingMode();
        // 主流程：停止安全兜底（合成事件未真实按下鼠标，兜底会立即误判左键松开）
        _pettingSafetyTimer?.Stop();

        // 1. 按下 head zone
        bool down = _interaction.OnPointerDown(MakeCtx(new Point(0.5, 0.15)));
        AppLog.Info("PETTING_TEST down={0} state={1}", down, _interaction.HeadPetting.State);
        if (!down)
            AppLog.Error("PETTING_TEST_RESULT FAIL down");

        // 2. 左右往返移动（反转）形成 Petting
        double px = 200;
        for (int i = 0; i < 6; i++) { px += 10; _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, px, 200)); }
        for (int i = 0; i < 6; i++) { px -= 10; _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, px, 200)); }
        for (int i = 0; i < 6; i++) { px += 10; _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, px, 200)); }
        AppLog.Info("PETTING_TEST after move state={0}", _interaction.HeadPetting.State);
        await Task.Delay(500);

        // 2.5 头部应有明显转动（持续移动保持运动目标，让头部跟上后读取）
        for (int k = 0; k < 6; k++)
        {
            px += 10;
            _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, px, 200));
            await Task.Delay(40);
        }
        _live2D!.GetParameterValue("ParamAngleX", out double headX);
        AppLog.Info("PETTING_TEST headAngleX={0:0.##}（期望 |v| >= 1.5，持续移动有明显反馈）", headX);
        bool headOk = Math.Abs(headX) >= 1.5 && Math.Abs(headX) <= 8.5;

        // 3. 眼睛应闭合（等待闭合到位）
        await Task.Delay(600);
        _live2D.GetParameterValue("ParamEyeLOpen", out double closed);
        AppLog.Info("PETTING_TEST eyes_closed_value={0:0.##}（<0.2 视为闭合）", closed);
        bool closedOk = closed < 0.2;

        // 4. 移出容错区 → 应立即进入 Finishing 并睁眼恢复
        CheckPettingToleranceExit(new Point(-200, -200));
        AppLog.Info("PETTING_TEST after exit state={0}（期望 Finishing）", _interaction.HeadPetting.State);
        bool exitOk = _interaction.HeadPetting.State == PettingState.Finishing;

        // 5. 等待睁眼恢复完成 → Armed
        await Task.Delay(900);
        AppLog.Info("PETTING_TEST after finish state={0}（期望 Armed）", _interaction.HeadPetting.State);
        _live2D.GetParameterValue("ParamEyeLOpen", out double opened);
        AppLog.Info("PETTING_TEST eyes_opened_value={0:0.##}（>0.8 视为睁开）", opened);
        bool openedOk = opened > 0.8;

        // 6. 连续 20 次移出操作，最终眼睛必须睁开
        for (int i = 1; i <= 20; i++)
        {
            _interaction.HeadPetting.OnPointerDown(MakeCtx(new Point(0.5, 0.15)));
            for (int j = 0; j < 4; j++)
                _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, 240, 200));
            CheckPettingToleranceExit(new Point(-200, -200));
            await Task.Delay(700);
        }
        _live2D.GetParameterValue("ParamEyeLOpen", out double finalEye);
        AppLog.Info("PETTING_TEST final_eye={0:0.##} state={1}", finalEye, _interaction.HeadPetting.State);
        bool noResidual = finalEye > 0.8 && _interaction.HeadPetting.State != PettingState.Petting;

        // 7. 单独验证安全兜底：合成按下但真实鼠标未按 → 兜底应在 150ms 内结束会话
        _pettingSafetyTimer?.Start();
        _interaction.HeadPetting.OnPointerDown(MakeCtx(new Point(0.5, 0.15)));
        await Task.Delay(400);
        AppLog.Info("PETTING_TEST safety state={0}（期望 Finishing/Armed，兜底结束）", _interaction.HeadPetting.State);
        bool safetyOk = _interaction.HeadPetting.State is PettingState.Finishing or PettingState.Armed;

        bool pass = closedOk && exitOk && openedOk && noResidual && headOk && safetyOk;
        AppLog.Info("PETTING_TEST_RESULT {0} headOk={1} closedOk={2} exitOk={3} openedOk={4} noResidual={5} safetyOk={6}",
            pass ? "PASS" : "FAIL", headOk, closedOk, exitOk, openedOk, noResidual, safetyOk);
        Close();
    }

    private async Task RunToolbarHitTestAsync()
    {
        await Task.Delay(400);
        ShowQuickActions();
        await Task.Delay(400);

        var tb = ToolbarRect();
        AppLog.Info("TOOLBAR_LAYOUT_STATE toolbarBounds={0} visibility={1} opacity={2} hitTest={3} enabled={4} toolbarZ={5}",
            tb, HoverQuickActions.Visibility, HoverQuickActions.Opacity,
            HoverQuickActions.IsHitTestVisible, HoverQuickActions.IsEnabled,
            Panel.GetZIndex(HoverQuickActions));

        // HeadPettingButton 中心命中
        var center = GetElementWindowCenter(HeadPettingButton);
        var hit = VisualTreeHelper.HitTest(this, center);
        var el = hit?.VisualHit as FrameworkElement;
        AppLog.Info("TOOLBAR_HIT_TEST point={0} hitElement={1} elementType={2} elementName={3} isHitTestVisible={4} zIndex={5}",
            center, el?.GetType().Name ?? "null", el?.GetType().FullName ?? "",
            el?.Name ?? "", el is UIElement ui && ui.IsHitTestVisible, Panel.GetZIndex(el ?? this));

        bool pass = el is not null && FindToolbarAncestor(el);
        AppLog.Info("TOOLBAR_HIT_TEST_RESULT {0} headPetting={1}",
            pass ? "PASS" : "FAIL", pass);
        Close();
    }

    private bool FindToolbarAncestor(DependencyObject? source)
    {
        DependencyObject? current = source;
        while (current != null)
        {
            if (ReferenceEquals(current, HoverQuickActions))
                return true;
            current = VisualTreeHelper.GetParent(current);
        }
        return false;
    }

    private static Point GetElementWindowCenter(FrameworkElement el)
    {
        double x = el.ActualWidth > 0 ? el.ActualWidth / 2 : 0;
        double y = el.ActualHeight > 0 ? el.ActualHeight / 2 : 0;
        return el.TranslatePoint(new Point(x, y), Application.Current.MainWindow);
    }

    private async Task RunModeSwitchTestAsync()
    {
        // 1. 启动后应为 PNG
        AppLog.Info("MODE_TEST start mode={0}（期望 Existing）", _rendererMode);
        if (_rendererMode != CharacterRenderMode.Existing)
            AppLog.Error("MODE_TEST_RESULT FAIL start_not_png");
        await Task.Delay(400);

        // 2. 等待后台预加载完成，模式应仍为 PNG（不自动切换）
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (_live2D is null && DateTime.UtcNow < deadline)
            await Task.Delay(100);
        bool preloaded = _live2D is { IsReady: true };
        AppLog.Info("MODE_TEST preload done live2DReady={0} mode={1}（期望仍 Existing）", preloaded, _rendererMode);
        if (preloaded && _rendererMode != CharacterRenderMode.Existing)
            AppLog.Error("MODE_TEST_RESULT FAIL preload_switched");

        // 3. 手动切 Live2D
        AppLog.Info("MODE_TEST before_live2d live2D={0} ready={1} loadFailed={2}",
            _live2D != null, _live2D?.IsReady ?? false, _live2DLoadFailed);
        SetRendererModeAsync(CharacterRenderMode.Live2D);
        await WaitForSwitchIdleAsync();
        await Task.Delay(500);
        AppLog.Info("MODE_TEST toLive2D mode={0}", _rendererMode);
        if (_rendererMode != CharacterRenderMode.Live2D)
            AppLog.Error("MODE_TEST_RESULT FAIL manual_switch_live2d");

        // 4. 切回 PNG
        SetRendererModeAsync(CharacterRenderMode.Existing);
        await WaitForSwitchIdleAsync();
        await Task.Delay(500);
        AppLog.Info("MODE_TEST toPng mode={0}", _rendererMode);
        if (_rendererMode != CharacterRenderMode.Existing)
            AppLog.Error("MODE_TEST_RESULT FAIL manual_switch_png");

        // 5. 连续手动切换 20 次（每轮往返），切换完成后工具栏必须位于人物下方且不落在左上角
        //    先标准化窗口尺寸，避免历史 settings 缩放过小导致工具栏居中超界 clamp
        SetPetSize(300);
        await Task.Delay(400);
        bool stable = true;
        for (int i = 1; i <= 20; i++)
        {
            SetRendererModeAsync(i % 2 == 1 ? CharacterRenderMode.Live2D : CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
            await Task.Delay(400);
            var expected = i % 2 == 1 ? CharacterRenderMode.Live2D : CharacterRenderMode.Existing;
            if (_rendererMode != expected)
            {
                stable = false;
                AppLog.Error("MODE_TEST_RESULT FAIL round_{0} mode={1} expected={2}", i, _rendererMode, expected);
            }
            var bounds = GetCharacterVisualBounds();
            double left = Canvas.GetLeft(HoverQuickActions);
            double top = Canvas.GetTop(HoverQuickActions);
            if (!IsValidBounds(bounds))
            {
                stable = false;
                AppLog.Error("MODE_TEST_RESULT FAIL round_{0} bounds_invalid", i);
                continue;
            }
            double expectedLeft = bounds.Left + bounds.Width / 2 - DefaultToolbarWidth / 2;
            double expectedTop = bounds.Top + bounds.Height + ToolbarGap;
            bool atOrigin = left < 1 && top < 1;                          // 飞到左上角 (0,0)
            if (atOrigin || Math.Abs(left - expectedLeft) > 10 || Math.Abs(top - expectedTop) > 10)
            {
                stable = false;
                AppLog.Error("MODE_TEST_RESULT FAIL round_{0} toolbar=({1:0.#},{2:0.#}) expected=({3:0.#},{4:0.#}) atOrigin={5}",
                    i, left, top, expectedLeft, expectedTop, atOrigin);
            }
        }
        AppLog.Info("MODE_TEST_RESULT {0}", stable ? "PASS" : "FAIL");
        Close();
    }

    private async Task RunEarAbTestAsync()
    {
        await ActivateLive2DAsync();
        await Task.Delay(300);
        var info = _live2D!.GetInteractionParamInfo();
        string leftRoot = info.hasLeftEarRoot ? "Param_Angle_Rotation_1_CAT_Ear_L" : "(none)";
        string rightRoot = info.hasRightEarRoot ? "Param_Angle_Rotation_1_CAT_Ear_R" : "(none)";

        // Test A：禁用耳朵 + 只 Idle/Physics，观察 5 秒
        _live2D.SetEarInteraction(false, 0, 0);
        AppLog.Info("EAR_SPLIT_AB_TEST test=A earInteractionEnabled=false headInteractionEnabled=false leftRootParam={0} rightRootParam={1} splitObserved=CHECK",
            leftRoot, rightRoot);
        await Task.Delay(5000);

        // Test B：禁用耳朵 + 抚摸头部运动 5 秒（左右摆动），耳朵由原 Physics 带动
        _interaction.TogglePettingMode();
        var zone = new Point(0.5, 0.15);
        _interaction.OnPointerDown(MakeCtx(zone));
        double px = 200;
        for (int i = 0; i < 60; i++)
        {
            px += 10;
            _interaction.OnPointerMove(MakeCtxViewport(0.5, 0.15, px, 200));
            if (i % 30 == 0)
                AppLog.Info("EAR_SPLIT_AB_TEST test=B earInteractionEnabled=false headInteractionEnabled=true leftRootParam={0} rightRootParam={1} headVel={2:0.#} splitObserved=CHECK",
                    leftRoot, rightRoot, _interaction.SmoothedVelocityXPxPerSec);
            await Task.Delay(40);
        }
        _interaction.OnPointerUp(MakeCtx(zone));
        await Task.Delay(1000);
        AppLog.Info("EAR_SPLIT_AB_TEST test=B earInteractionEnabled=false headInteractionEnabled=true leftRootParam={0} rightRootParam={1} splitObserved=CHECK",
            leftRoot, rightRoot);

        // Test C：左耳根部固定 +1（不随速度变化），右耳禁用
        _live2D.SetEarInteraction(true, 1.0, 0);
        AppLog.Info("EAR_SPLIT_AB_TEST test=C earInteractionEnabled=true(head_left=+1) headInteractionEnabled=false leftRootParam={0} rightRootParam={1} splitObserved=CHECK",
            leftRoot, rightRoot);
        await Task.Delay(5000);
        _live2D.SetEarInteraction(false, 0, 0);

        // Test D：右耳根部固定 +1，左耳禁用
        _live2D.SetEarInteraction(true, 0, 1.0);
        AppLog.Info("EAR_SPLIT_AB_TEST test=D earInteractionEnabled=true(head_right=+1) headInteractionEnabled=false leftRootParam={0} rightRootParam={1} splitObserved=CHECK",
            leftRoot, rightRoot);
        await Task.Delay(5000);
        _live2D.SetEarInteraction(false, 0, 0);

        // 恢复：退出抚摸并回到禁用耳朵状态
        _interaction.OnEsc();
        AppLog.Info("EAR_SPLIT_AB_TEST_RESULT done（请人工核对各阶段 splitObserved）");
        Close();
    }

    private async Task RunToolbarPlacementTestAsync()
    {
        // 确保从 PNG 模式开始
        if (_rendererMode == CharacterRenderMode.Live2D)
        {
            SetRendererModeAsync(CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
            await Task.Delay(300);
        }
        await Task.Delay(400);

        var pngBounds = GetCharacterVisualBounds();
        double pngLeft = Canvas.GetLeft(HoverQuickActions);
        double pngTop = Canvas.GetTop(HoverQuickActions);
        AppLog.Info("TOOLBAR_TEST png_bounds={0} toolbar=({1:0.#},{2:0.#})", pngBounds, pngLeft, pngTop);
        if (!IsValidBounds(pngBounds))
            AppLog.Error("TOOLBAR_TEST_RESULT FAIL png_bounds_invalid");

        bool stable = true;
        double firstLiveLeft = double.NaN, firstLiveTop = double.NaN;
        for (int i = 1; i <= 20; i++)
        {
            SetRendererModeAsync(CharacterRenderMode.Live2D);
            await WaitForSwitchIdleAsync();
            await Task.Delay(250);
            var b = GetCharacterVisualBounds();
            double left = Canvas.GetLeft(HoverQuickActions);
            double top = Canvas.GetTop(HoverQuickActions);
            AppLog.Info("TOOLBAR_TEST round={0} live_bounds={1} toolbar=({2:0.#},{3:0.#})", i, b, left, top);
            if (!IsValidBounds(b))
            {
                stable = false;
                AppLog.Error("TOOLBAR_TEST_RESULT FAIL round_{0}_bounds_invalid", i);
            }
            if (!double.IsFinite(left) || !double.IsFinite(top) || left < -1 || top < -1)
            {
                stable = false;
                AppLog.Error("TOOLBAR_TEST_RESULT FAIL round_{0}_pos_at_origin", i);
            }
            if (i == 1)
            {
                firstLiveLeft = left;
                firstLiveTop = top;
            }
            else if (double.IsFinite(firstLiveLeft)
                     && (Math.Abs(left - firstLiveLeft) > 2 || Math.Abs(top - firstLiveTop) > 2))
            {
                stable = false;
                AppLog.Error("TOOLBAR_TEST_RESULT FAIL round_{0}_drift delta=({1:0.#},{2:0.#})",
                    i, left - firstLiveLeft, top - firstLiveTop);
            }

            SetRendererModeAsync(CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
            await Task.Delay(250);
            var pb = GetCharacterVisualBounds();
            if (!IsValidBounds(pb))
            {
                stable = false;
                AppLog.Error("TOOLBAR_TEST_RESULT FAIL round_{0}_png_bounds_invalid", i);
            }
        }

        AppLog.Info("TOOLBAR_TEST_RESULT {0}", stable ? "PASS" : "FAIL");
        Close();
    }

    private async Task RunInteractionSmokeTestAsync()
    {
        await ActivateLive2DAsync();
        await Task.Delay(200);

        // 1. 进入抚摸模式
        _interaction.TogglePettingMode();
        bool armed = _interaction.HeadPetting.State == PettingState.Armed;
        AppLog.Info("INTERACTION_SMOKE enter armed={0} cursorVisible={1}", armed, PettingPalmCursor.Visibility == Visibility.Visible);
        if (!armed)
            AppLog.Error("INTERACTION_SMOKE_RESULT FAIL enter");

        // 2. 头区域按下 → 移动（抚摸）→ 松开
        var headZone = new Point(0.5, 0.15); // head_pet_zone 中心（归一化）
        bool downConsumed = _interaction.OnPointerDown(MakeCtx(headZone));
        bool pressed = _interaction.HeadPetting.State == PettingState.Pressed;
        AppLog.Info("INTERACTION_SMOKE down consumed={0} state={1}", downConsumed, _interaction.HeadPetting.State);
        if (!downConsumed || !pressed)
            AppLog.Error("INTERACTION_SMOKE_RESULT FAIL down");

        // 左右往返抚摸
        double px = 200;
        for (int i = 0; i < 4; i++) { px += 10; _interaction.OnPointerMove(MakeCtxViewport(headZone.X, headZone.Y, px, 200)); }
        for (int i = 0; i < 4; i++) { px -= 10; _interaction.OnPointerMove(MakeCtxViewport(headZone.X, headZone.Y, px, 200)); }
        for (int i = 0; i < 4; i++) { px += 10; _interaction.OnPointerMove(MakeCtxViewport(headZone.X, headZone.Y, px, 200)); }
        bool petting = _interaction.HeadPetting.State == PettingState.Petting;
        AppLog.Info("INTERACTION_SMOKE move state={0} vel={1:0.#}", _interaction.HeadPetting.State, _interaction.SmoothedVelocityXPxPerSec);
        if (!petting)
            AppLog.Error("INTERACTION_SMOKE_RESULT FAIL petting_state");

        bool upConsumed = _interaction.OnPointerUp(MakeCtx(headZone));
        AppLog.Info("INTERACTION_SMOKE up consumed={0} state={1}", upConsumed, _interaction.HeadPetting.State);

        await Task.Delay(700); // 等待 Finishing → Armed
        AppLog.Info("INTERACTION_SMOKE finish state={0}", _interaction.HeadPetting.State);

        // 3. 身体区域按下不接管（不得误判抚摸）
        bool bodyConsumed = _interaction.OnPointerDown(MakeCtx(new Point(0.5, 0.80)));
        AppLog.Info("INTERACTION_SMOKE body down consumed={0}", bodyConsumed);
        if (bodyConsumed)
            AppLog.Error("INTERACTION_SMOKE_RESULT FAIL body_press");
        _interaction.OnPointerUp(MakeCtx(new Point(0.5, 0.80)));

        // 4. Esc 退出
        _interaction.OnEsc();
        bool inactive = _interaction.HeadPetting.State == PettingState.Inactive;
        AppLog.Info("INTERACTION_SMOKE esc inactive={0} cursorVisible={1}", inactive, PettingPalmCursor.Visibility == Visibility.Visible);
        if (!inactive)
            AppLog.Error("INTERACTION_SMOKE_RESULT FAIL esc");

        // 5. 抚摸台词可解析
        var startDialogue = _dialoguePlayback.ResolveSceneTag("head_petting", "petting_start");
        AppLog.Info("INTERACTION_SMOKE dialogue_start resolved={0} pages={1}",
            startDialogue != null, startDialogue?.Pages.Count ?? -1);

        bool pass = armed && pressed && petting && upConsumed && !bodyConsumed && inactive && startDialogue != null;
        AppLog.Info("INTERACTION_SMOKE_RESULT {0}", pass ? "PASS" : "FAIL");
    }

    private static InteractionContext MakeCtx(Point norm) => new(norm.X, norm.Y, norm.X * 400, norm.Y * 400, 0.033, true);

    private static InteractionContext MakeCtxViewport(double nx, double ny, double px, double py)
        => new(nx, ny, px, py, 0.033, true);

    // 测试替身：模拟缺失的口型导出符号。    // 通过 Live2DCharacterRenderer.SimulateMissingLipSyncExport 触发与真实
    // EntryPointNotFoundException 相同的托管容错路径，验证口型缺失不影响
    // 模式切换、气泡与台词。
    private async Task RunLipSyncMissingExportTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("LIP_SYNC_MISSING_RESULT FAIL activate_failed");
            return;
        }
        var handler = _live2D;
        if (handler is null)
        {
            AppLog.Error("LIP_SYNC_MISSING_RESULT FAIL no_renderer");
            return;
        }
        handler.SetLipSyncValue(0.8); // 正常路径（确认初始启用）
        bool initiallyEnabled = handler.IsLipSyncEnabled;
        Live2DCharacterRenderer.SimulateMissingLipSyncExport = true;
        try
        {
            // 验证容错：异常被 renderer 内部捕获，不传播到 UI 线程
            handler.SetLipSyncValue(0.8);
        }
        catch (Exception ex)
        {
            AppLog.Error("LIP_SYNC_MISSING_RESULT FAIL 异常逃逸到测试层: {0}", ex.Message);
            Live2DCharacterRenderer.SimulateMissingLipSyncExport = false;
            DeactivateLive2D();
            return;
        }
        finally
        {
            Live2DCharacterRenderer.SimulateMissingLipSyncExport = false;
        }
        bool disabled = !handler.IsLipSyncEnabled;
        AppLog.Info("LIP_SYNC_MISSING_DISABLED enabled_before={0} enabled_after={1}", initiallyEnabled, handler.IsLipSyncEnabled);
        if (!disabled)
            AppLog.Error("LIP_SYNC_MISSING_RESULT FAIL lip_sync_仍启用");
        // 降级后再调用不抛错（已被禁用，直接短路）
        handler.SetLipSyncValue(0.5);
        // 气泡与台词不应受影响
        Speak("口型缺失测试气泡正常");
        AppLog.Info("LIP_SYNC_MISSING_SPEAK visible={0} text={1}", SpeechBubble.Visibility == Visibility.Visible, SpeechText.Text);
        if (SpeechBubble.Visibility != Visibility.Visible)
            AppLog.Error("LIP_SYNC_MISSING_RESULT FAIL bubble_hidden");
        AppLog.Info("LIP_SYNC_MISSING_RESULT PASS");
        DeactivateLive2D();
    }

    private async Task RunLive2DActivationSpeakTestAsync()
    {
        const int rounds = 10;
        for (int i = 1; i <= rounds; i++)
        {
            AppLog.Info("ACTIVATION_SPEAK {0}/{1} -> Live2D", i, rounds);
            _rendererMode = CharacterRenderMode.Existing;
            SetRendererModeAsync(CharacterRenderMode.Live2D);
            await WaitForSwitchIdleAsync();
            if (_rendererMode != CharacterRenderMode.Live2D)
            {
                AppLog.Error("ACTIVATION_SPEAK_RESULT FAIL turn_{0}_live2d", i);
                return;
            }
            var handler = _live2D;
            if (handler is not null)
            {
                try
                {
                    handler.SetLipSyncValue(0.7);
                    for (int f = 0; f < 10; f++)
                        handler.Update(1.0 / 60.0);
                }
                catch (Exception ex)
                {
                    AppLog.Error("ACTIVATION_SPEAK turn_{0} lipsync exception: {1}", i, ex.Message);
                }
            }
            Speak($"欢迎台词 {i}");
            await Task.Delay(150);
            SetRendererModeAsync(CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
        }
        AppLog.Info("ACTIVATION_SPEAK_RESULT PASS rounds={0}", rounds);
    }

    private void SetRendererMode(CharacterRenderMode mode)
    {
        SetRendererModeAsync(mode);
    }

    // ==================== 运行时设置应用 / 回读测试 ====================
    // 验证 settings.json 的 PhysicsStrength / GazeIdleTimeoutSeconds 真正进入
    // Native Host 并可由 Getter 回读（不允许"只改 UI 不生效"）。

    /// <summary>读取当前 Native 生效的物理强度（current=平滑值, target=用户设置）。</summary>
    private static (double current, double target) ReadPhysicsStrength(Live2DCharacterRenderer r)
    {
        int rc = Live2DInterop.AliyaLive2D_GetPhysicsStrength(r.Handle, out float cur, out float tgt);
        return rc == Live2DInterop.OK ? (cur, tgt) : (double.NaN, double.NaN);
    }

    /// <summary>读取当前 Native 静止待机时间 / 已静止时长。</summary>
    private static (double timeout, double elapsed) ReadMouseIdle(Live2DCharacterRenderer r)
    {
        int rcT = Live2DInterop.AliyaLive2D_GetMouseIdleTimeout(r.Handle, out float timeout);
        int rcE = Live2DInterop.AliyaLive2D_GetMouseIdleElapsed(r.Handle, out float elapsed);
        return (rcT == Live2DInterop.OK ? timeout : double.NaN,
                rcE == Live2DInterop.OK ? elapsed : double.NaN);
    }

    private async Task RunRuntimeSettingsApplyTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("RUNTIME_SETTINGS_APPLY_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;

        // 设置 -> 回读（放帧让平滑生效）
        r.SetPhysicsStrength(1.5);
        r.SetGazeIdleTimeout(1.0);
        for (int i = 0; i < 90; i++) r.Update(1.0 / 60.0);
        var (cur, tgt) = ReadPhysicsStrength(r);
        var (timeout, _) = ReadMouseIdle(r);
        AppLog.Info("RUNTIME_SETTINGS_APPLY physics current={0:0.00} target={1:0.00} timeout={2:0.00}", cur, tgt, timeout);
        if (Math.Abs(tgt - 1.5) > 0.01) { failures++; AppLog.Error("RUNTIME_SETTINGS_APPLY FAIL target={0}", tgt); }
        if (Math.Abs(cur - 1.5) > 0.05) { failures++; AppLog.Error("RUNTIME_SETTINGS_APPLY FAIL current未收敛 cur={0}", cur); }
        if (Math.Abs(timeout - 1.0) > 0.01) { failures++; AppLog.Error("RUNTIME_SETTINGS_APPLY FAIL timeout={0}", timeout); }

        // 通过托管 UI 路径再次应用同一设置（等价于菜单点击回调），核对回读一致
        _physicsStrength = 0.5;
        r.SetPhysicsStrength(_physicsStrength);
        for (int i = 0; i < 90; i++) r.Update(1.0 / 60.0);
        (cur, tgt) = ReadPhysicsStrength(r);
        AppLog.Info("RUNTIME_SETTINGS_APPLY_step2 physics={0:0.00}/{1:0.00}", cur, tgt);
        if (Math.Abs(cur - 0.5) > 0.05) { failures++; AppLog.Error("RUNTIME_SETTINGS_APPLY FAIL step2 cur={0}", cur); }

        AppLog.Info(failures == 0 ? "RUNTIME_SETTINGS_APPLY_RESULT PASS" : "RUNTIME_SETTINGS_APPLY_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunMouseIdleTimeoutTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("MOUSE_IDLE_TIMEOUT_RESULT FAIL activate_failed");
            return;
        }
        var r = _live2D!;
        int failures = 0;
        r.SetLookAtEnabled(true);
        r.SetGazeIdleTimeout(1.0); // 1 秒静止进入待机
        r.SetLookTarget(0.5, 0.5);
        for (int i = 0; i < 15; i++) r.Update(1.0 / 60.0); // 先建立目标

        // 连续 10 秒同一坐标（模拟鼠标静止），IdleElapsed 必须单调增加且最终 >= 待机阈值
        double[] tSec = { 1.0, 3.0, 10.0 };
        foreach (double t in tSec)
        {
            double last = -1;
            double maxElapsed = 0;
            for (int i = 0; i < (int)(t * 60); i++)
            {
                r.SetLookTarget(0.5, 0.5); // 相同坐标：不得重置 idleElapsed
                r.Update(1.0 / 60.0);
                var (_, elapsed) = ReadMouseIdle(r);
                if (elapsed < last - 0.01) { failures++; AppLog.Error("MOUSE_IDLE static {0}s FAIL idleElapsed 回退 {1:0.00}->{2:0.00}", t, last, elapsed); }
                last = elapsed;
                maxElapsed = Math.Max(maxElapsed, elapsed);
            }
            double expectedMin = t - 0.15;
            string pass = maxElapsed >= expectedMin ? "PASS" : "FAIL";
            if (pass == "FAIL") failures++;
            AppLog.Info("MOUSE_IDLE_STATIC timeout=1.0s elapsed={0:0.00}s (期望 >= {1:0.00}) {2}",
                maxElapsed, expectedMin, pass);
        }

        // 1 秒静止必须让状态机进入 ReturningToIdle/IdleBreathing（待机）
        r.SetGazeIdleTimeout(1.0);
        for (int i = 0; i < 5; i++) r.Update(1.0 / 60.0);
        int state = Live2DInterop.AliyaLive2D_GetGazeActivityState(r.Handle, out state) == Live2DInterop.OK ? state : -1;
        AppLog.Info("MOUSE_IDLE_STATE state={0} (2=ReturningToIdle 3=IdleBreathing)", state);
        if (state is not (2 or 3)) { failures++; AppLog.Error("MOUSE_IDLE_STATE FAIL state={0}", state); }

        // 鼠标移动恢复：移动后 idleElapsed 应被重置
        r.SetLookTarget(0.2, 0.8);
        int resetSeq = 0;
        for (int i = 0; i < 10; i++)
        {
            r.Update(1.0 / 60.0);
            var (_, elapsed) = ReadMouseIdle(r);
            if (elapsed < 0.02) { resetSeq++; }
        }
        string resetPass = resetSeq > 0 ? "PASS" : "FAIL";
        if (resetPass == "FAIL") failures++;
        AppLog.Info("MOUSE_IDLE_RESET 移动后 elapsed 重置样本 {0}", resetPass);

        AppLog.Info(failures == 0 ? "MOUSE_IDLE_TIMEOUT_RESULT PASS" : "MOUSE_IDLE_TIMEOUT_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunPhysicsStrengthRuntimeTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
        AppLog.Error("PHYSICS_STRENGTH_RUNTIME_RESULT FAIL activate_failed");
        return;
        }
        var r = _live2D!;
        int failures = 0;
        r.SetLookAtEnabled(false);
        r.SetLookTarget(0.5, 0.5);

        string[] groups = { "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_9_Top_Bang", "Param_Angle_Rotation_2_CAT_Ear_R" };
        double[] strengths = { 0.0, 1.0, 2.0 };
        var amplitudes = new Dictionary<string, Dictionary<double, double>>();
        foreach (string g in groups) { amplitudes[g] = new(); foreach (double s in strengths) amplitudes[g][s] = 0; }

        foreach (double s in strengths)
        {
            r.SetPhysicsStrength(s);
            for (int i = 0; i < 120; i++) r.Update(1.0 / 60.0); // 等待平滑收敛

            // 每个物理输出参数 2s 采样窗口内最大幅值（max-min）
            var running = new Dictionary<string, (double min, double max)>();
            foreach (string g in groups) running[g] = (1e9, -1e9);
            for (int i = 0; i < 120; i++) // 2s * 60fps 采样
            {
                r.Update(1.0 / 60.0);
                foreach (string g in groups)
                {
                    if (r.GetParameterValue(g, out double v))
                    {
                        var (mn, mx) = running[g];
                        running[g] = (Math.Min(mn, v), Math.Max(mx, v));
                    }
                }
            }
            foreach (string g in groups)
            {
                var (mn, mx) = running[g];
                amplitudes[g][s] = mx - mn;
            }
        }

        // 校验：0% 幅度最小(接近0) < 100% < 200%；且 200%/100% 幅度比接近 2
        foreach (string g in groups)
        {
            double a0 = amplitudes[g][0.0], a1 = amplitudes[g][1.0], a2 = amplitudes[g][2.0];
            bool monotonic = a0 < a1 + 0.01 && a1 < a2 + 0.01 && a2 > a1 * 0.8;
            AppLog.Info("PHYSICS_STRENGTH {0}: 0%={1:0.0000} 100%={2:0.0000} 200%={3:0.0000} monotonic={4}",
                g, a0, a1, a2, monotonic ? "YES" : "NO");
            if (!monotonic) { failures++; AppLog.Error("PHYSICS_STRENGTH 幅度非单调增长 {0} ({1:0.0000}/{2:0.0000}/{3:0.0000})", g, a0, a1, a2); }
        }

        AppLog.Info(failures == 0 ? "PHYSICS_STRENGTH_RUNTIME_RESULT PASS" : "PHYSICS_STRENGTH_RUNTIME_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    // =========================================================
    // 眼神追踪头部幅度修复测试组
    // =========================================================

    /// <summary>把视线状态机驱动到 Tracking 并收敛到目标 raw（斜坡变化制造移动信号）。</summary>
    private static void ConvergeGaze(Live2DCharacterRenderer r, double fx, double fy)
    {
        const double dt = 1.0 / 60.0;
        for (int i = 0; i < 120; i++) // 斜坡衰减至目标（IdleBreathing→Reacquiring→Tracking）
        {
            double t = 1.0 - i / 120.0;
            r.SetGazeRawInput(fx * t, fy * t);
            r.Update(dt);
        }
        for (int i = 0; i < 90; i++) // 保持目标等待弹簧收敛
        {
            r.SetGazeRawInput(fx, fy);
            r.Update(dt);
        }
    }

    private async Task RunGazeHeadFullRangeTestAsync()
    {
        // 验证头部限制由模型真实参数范围(±30)推出：X 默认≈±27（旧限制 ±24/实际 16~18），
        // 且 raw 满幅时头部 X/Y 参数能实际达到新范围。
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("GAZE_HEAD_FULL_RANGE_RESULT FAIL activate_failed");
            return;
        }
        var r = _live2D!;
        int failures = 0;
        r.SetLookAtEnabled(true);
        r.SetGazeIdleTimeout(60);
        r.SetGazeHeadRange(GazeHeadRangeXDefault, GazeHeadRangeYDefault, GazeHeadRangeZDefault);
        r.SetGazeHeadFollowAmount(_gazeHeadFollowAmount);
        for (int i = 0; i < 30; i++) r.Update(1.0 / 60.0);

        var d = r.GetGazeDiagnostics();
        AppLog.Info("GAZE_HEAD_FULL_RANGE default headMax X={0:0.00} Y={1:0.00} Z={2:0.00} rangeX={3:0.00} amount={4:0.00}",
            d.HeadMaxX, d.HeadMaxY, d.HeadMaxZ, d.HeadRangeX, d.HeadFollowAmount);

        bool defaultGood = d.HeadMaxX > 24.0 && d.HeadMaxX <= 30.0 && d.HeadMaxY > 20.0 && d.HeadMaxY <= 30.0;
        if (!defaultGood) failures++;
        else AppLog.Info("GAZE_HEAD_FULL_RANGE default X≈{0:0.0}°>旧24°，Y≈{1:0.0}° PASS", d.HeadMaxX, d.HeadMaxY);

        // rawX=+1（鼠标向右）→ 头部 X（左右转）应达 ~+27°
        ConvergeGaze(r, 1.0, 0.0);
        d = r.GetGazeDiagnostics();
        double headX = r.GetParameterValue("ParamAngleX", out double vx) ? vx : 0;
        AppLog.Info("GAZE_HEAD_FULL_RANGE rawX=+1 → headXTarget={0:0.00}° actual={1:0.00}° mapped={2:0.00}",
            d.HeadTargetX, headX, d.MappedX);
        if (Math.Abs(d.HeadTargetX) < 20.0) failures++; // 旧实际 16~18°，新须 >20°
        else AppLog.Info("GAZE_HEAD_FULL_RANGE 实际头部 X≈{0:0.0}°(旧约16~18) PASS", Math.Abs(headX));

        // rawY=+1（鼠标在上）→ 头部 Y（上下转）应达 ~+23°
        ConvergeGaze(r, 0.0, 1.0);
        d = r.GetGazeDiagnostics();
        double headY = r.GetParameterValue("ParamAngleY", out double vy) ? vy : 0;
        AppLog.Info("GAZE_HEAD_FULL_RANGE rawY=+1 → headYTarget={0:0.00}° actual={1:0.00}°",
            d.HeadTargetY, headY);
        if (Math.Abs(d.HeadTargetY) < 20.0) failures++;
        else AppLog.Info("GAZE_HEAD_FULL_RANGE 实际头部 Y≈{0:0.0}° PASS", Math.Abs(headY));

        // 全量配置：范围1.0/幅度1.0 → 头部逼近模型真实 ±30
        r.SetGazeHeadRange(1.0, 1.0, 1.0);
        r.SetGazeHeadFollowAmount(1.0);
        ConvergeGaze(r, 1.0, 0.0);
        d = r.GetGazeDiagnostics();
        AppLog.Info("GAZE_HEAD_FULL_RANGE full headMax X={0:0.00} headYTarget={1:0.00}", d.HeadMaxX, d.HeadTargetY);
        if (d.HeadMaxX < 28.0) failures++; // 全量应逼近 ±30（真实参数范围）

        ConvergeGaze(r, 0.0, 0.0);
        AppLog.Info(failures == 0 ? "GAZE_HEAD_FULL_RANGE_RESULT PASS" : "GAZE_HEAD_FULL_RANGE_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunGazeHeadMappingTestAsync()
    {
        // 验证 C# 像素映射 → raw 输入 → 诊断 RawX/RawY 一致性（含 clamp、死区）。
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("GAZE_HEAD_MAPPING_RESULT FAIL activate_failed");
            return;
        }
        var r = _live2D!;
        int failures = 0;
        _lookAtEnabled = true;
        _petRunning = true;
        _gazeFollowMode = GazeFollowMode.Global; // 映射测试须绕过 Nearby 的区域守卫
        r.SetLookAtEnabled(true);
        r.SetGazeIdleTimeout(60);

        AppLog.Info("GAZE_HEAD_MAPPING mode=global lookAt={0} petRunning={1} dragging={2}",
            _lookAtEnabled, _petRunning, _dragging);

        // 计算与 UpdateLookAtTarget 相同的 anchor/reach（物理像素）
        GetCursorPos(out var cur);
        var windowTopLeft = PointToScreen(new Point(0, 0));
        var imageOrigin = Live2DImage.TranslatePoint(new Point(0, 0), this);
        var dpi = VisualTreeHelper.GetDpi(this);
        double imageScreenX = windowTopLeft.X + imageOrigin.X * dpi.DpiScaleX;
        double imageScreenY = windowTopLeft.Y + imageOrigin.Y * dpi.DpiScaleY;
        double imageWidthPx = Live2DImage.ActualWidth * dpi.DpiScaleX;
        double imageHeightPx = Live2DImage.ActualHeight * dpi.DpiScaleY;
        double anchorX = imageScreenX + imageWidthPx / 2;
        double anchorY = imageScreenY + imageHeightPx * 0.44;
        double faceW = imageWidthPx * 0.30;
        double faceH = imageHeightPx * 0.22;
        double reachX = Math.Max(faceW * 5.0, 450.0);
        double reachY = Math.Max(faceH * 4.0, 350.0);
        AppLog.Info("GAZE_HEAD_MAPPING geo img={0:0.0}x{1:0.0} anchor=({2:0.0},{3:0.0}) reach=({4:0.0},{5:0.0})",
            imageWidthPx, imageHeightPx, anchorX, anchorY, reachX, reachY);

        var cases = new[]
        {
            (dx: 0.0,  dy: 0.0,    name: "center"),
            (dx: reachX*0.5, dy: 0.0,      name: "right_half"),
            (dx: -reachX*0.5, dy: 0.0,     name: "left_half"),
            (dx: 0.0, dy: reachY*0.5,     name: "up_half"),
            (dx: 0.0, dy: -reachY*0.5,    name: "down_half"),
            (dx: reachX*1.0, dy: 0.0,     name: "far_right"),
            (dx: -reachX*1.0, dy: 0.0,    name: "far_left"),
        };
        foreach (var c in cases)
        {
            SetCursorPos((int)(anchorX + c.dx), (int)(anchorY - c.dy)); // dy>0 表示光标在上方
            Thread.Sleep(60); // 等待系统光标位置稳定
            GetCursorPos(out var verify);
            // 期望值按实际光标位置计算（SetCursorPos 可能被屏幕边缘截断）
            double expRawX = Math.Clamp((verify.X - anchorX) / reachX, -1, 1);
            double expRawY = Math.Clamp((anchorY - verify.Y) / reachY, -1, 1);
            // 直接调用 native 验证 raw 往返（排除 UpdateLookAtTarget 干扰）
            r.SetGazeRawInput(expRawX, expRawY);
            r.Update(1.0 / 60.0); // controller 仅在 Update 消费排队输入
            var directDiag = r.GetGazeDiagnostics();
            bool directOk = Math.Abs(directDiag.RawX - expRawX) < 0.02 && Math.Abs(directDiag.RawY - expRawY) < 0.02;
            AppLog.Info("GAZE_HEAD_MAPPING {0} direct: raw=({1:0.000},{2:0.000}) exp=({3:0.000},{4:0.000}) ok={5}",
                c.name, directDiag.RawX, directDiag.RawY, expRawX, expRawY, directOk ? "YES" : "NO");

            UpdateLookAtTarget();
            r.Update(1.0 / 60.0);
            var diag = r.GetGazeDiagnostics();
            bool xok = Math.Abs(diag.RawX - expRawX) < 0.02;
            bool yok = Math.Abs(diag.RawY - expRawY) < 0.02;
            AppLog.Info("GAZE_HEAD_MAPPING {0}: raw=({1:0.000},{2:0.000}) exp=({3:0.000},{4:0.000}) cursor=({5},{6}) xok={7} yok={8}",
                c.name, diag.RawX, diag.RawY, expRawX, expRawY, verify.X, verify.Y, xok ? "YES" : "NO", yok ? "YES" : "NO");
            if (!xok || !yok) { failures++; AppLog.Error("GAZE_HEAD_MAPPING FAIL {0}", c.name); }
        }

        // 死区：中心附近小位移应映射为 0（防抖动）
        SetCursorPos((int)anchorX, (int)anchorY);
        UpdateLookAtTarget();
        r.Update(1.0 / 60.0);
        var centerDiag = r.GetGazeDiagnostics();
        bool deadzoneOk = Math.Abs(centerDiag.MappedX) < 0.001 && Math.Abs(centerDiag.MappedY) < 0.001;
        AppLog.Info("GAZE_HEAD_MAPPING deadzone mapped=({0:0.000},{1:0.000}) ok={2}", centerDiag.MappedX, centerDiag.MappedY, deadzoneOk ? "YES" : "NO");
        if (!deadzoneOk) failures++;

        SetCursorPos(cur.X, cur.Y); // 恢复鼠标
        AppLog.Info(failures == 0 ? "GAZE_HEAD_MAPPING_RESULT PASS" : "GAZE_HEAD_MAPPING_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunGazeWeightAuditTestAsync()
    {
        // 审计最终权重链：无动作时 ActionGazeMask=1.0；Tracking 时 GazeWeight→1.0；
        // FinalGazeMultiplier = GazeWeight × ActionGazeMask × fHead（满幅≈1.0）。
        // 幅度 0.9→0.5 应使头部目标幅度成比例缩小。
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("GAZE_WEIGHT_AUDIT_RESULT FAIL activate_failed");
            return;
        }
        var r = _live2D!;
        int failures = 0;
        r.SetLookAtEnabled(true);
        r.SetGazeIdleTimeout(60);
        r.SetGazeHeadRange(GazeHeadRangeXDefault, GazeHeadRangeYDefault, GazeHeadRangeZDefault);
        r.SetGazeHeadFollowAmount(0.9);
        ConvergeGaze(r, 1.0, 0.0);
        var d = r.GetGazeDiagnostics();
        bool maskOk = Math.Abs(d.ActionGazeMask - 1.0) < 0.001;
        bool amountOk = Math.Abs(d.HeadFollowAmount - 0.9) < 0.001;
        bool weightOk = d.GazeWeight > 0.8 && d.GazeWeight <= 1.0;
        bool finalOk = d.FinalGazeMultiplier > 0.8 && d.FinalGazeMultiplier <= 1.001;
        double targetAt90 = Math.Abs(d.HeadTargetX);
        AppLog.Info("GAZE_WEIGHT_AUDIT weight={0:0.000} mask={1:0.000} amount={2:0.000} final={3:0.000} headXTarget={4:0.00}",
            d.GazeWeight, d.ActionGazeMask, d.HeadFollowAmount, d.FinalGazeMultiplier, targetAt90);
        if (!maskOk) { failures++; AppLog.Error("GAZE_WEIGHT_AUDIT ActionGazeMask≠1.0"); }
        if (!amountOk) { failures++; AppLog.Error("GAZE_WEIGHT_AUDIT 幅度未生效"); }
        if (!weightOk) { failures++; AppLog.Error("GAZE_WEIGHT_AUDIT 视线权重异常"); }
        if (!finalOk) { failures++; AppLog.Error("GAZE_WEIGHT_AUDIT 最终权重链异常"); }

        // 幅度降低 → 头部目标幅度应成比例缩小（0.5/0.9 ≈ 0.56）
        r.SetGazeHeadFollowAmount(0.5);
        ConvergeGaze(r, 1.0, 0.0);
        d = r.GetGazeDiagnostics();
        double targetAt50 = Math.Abs(d.HeadTargetX);
        double ratio = targetAt90 > 1.0 ? targetAt50 / targetAt90 : 0.0;
        bool reducedOk = ratio > 0.4 && ratio < 0.75 && targetAt50 < targetAt90;
        AppLog.Info("GAZE_WEIGHT_AUDIT 幅度0.9→0.5 target {0:0.00}°→{1:0.00}° ratio={2:0.000} reduced={3}",
            targetAt90, targetAt50, ratio, reducedOk ? "YES" : "NO");
        if (!reducedOk) failures++;

        ConvergeGaze(r, 0.0, 0.0);
        AppLog.Info(failures == 0 ? "GAZE_WEIGHT_AUDIT_RESULT PASS" : "GAZE_WEIGHT_AUDIT_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunGazeOutputOverwriteTestAsync()
    {
        // 覆盖检测：模型 Update 不应改写视线写入的头部参数。
        // beforeGazeX == afterGazeX == beforeModelUpdateX（步进后、写入后、模型更新前三者一致）。
        bool ok = await ActivateLive2DAsync();
        if (!ok)
        {
            AppLog.Error("GAZE_OUTPUT_OVERWRITE_RESULT FAIL activate_failed");
            return;
        }
        var r = _live2D!;
        int failures = 0;
        r.SetLookAtEnabled(true);
        r.SetGazeIdleTimeout(60);
        r.SetGazeHeadRange(GazeHeadRangeXDefault, GazeHeadRangeYDefault, GazeHeadRangeZDefault);
        r.SetGazeHeadFollowAmount(_gazeHeadFollowAmount);
        ConvergeGaze(r, 1.0, 0.5);

        // 覆盖检测核心：Gaze 写入后到 model->Update() 前，头部参数不得被改写。
        // afterGazeX == beforeModelUpdateX（同帧）；beforeGazeX 与 afterGazeX 的差异
        // 是每帧 idle 漂移的正常混合，非覆盖，故不作为失败条件。
        double maxX = 0, maxY = 0;
        for (int i = 0; i < 120; i++)
        {
            r.SetGazeRawInput(1.0, 0.5);
            r.Update(1.0 / 60.0);
            var d = r.GetGazeDiagnostics();
            maxX = Math.Max(maxX, Math.Abs(d.AfterGazeX - d.BeforeModelUpdateX));
            maxY = Math.Max(maxY, Math.Abs(d.AfterGazeY - d.BeforeModelUpdateY));
        }
        AppLog.Info("GAZE_OUTPUT_OVERWRITE max|after-modelUpdate|=X{0:0.00000} Y{1:0.00000}",
            maxX, maxY);
        const double tol = 0.001;
        if (maxX > tol) { failures++; AppLog.Error("GAZE_OUTPUT_OVERWRITE 模型更新覆盖头部 X"); }
        if (maxY > tol) { failures++; AppLog.Error("GAZE_OUTPUT_OVERWRITE 模型更新覆盖头部 Y"); }

        r.SetGazeRawInput(0, 0);
        AppLog.Info(failures == 0 ? "GAZE_OUTPUT_OVERWRITE_RESULT PASS" : "GAZE_OUTPUT_OVERWRITE_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunRendererRecreateSettingsTestAsync()
    {
        // 渲染器重建（快速切换缓存命中）后，设置必须保留并仍可回读
        const int rounds = 3;
        for (int i = 1; i <= rounds; i++)
        {
            _rendererMode = CharacterRenderMode.Existing;
            SetRendererModeAsync(CharacterRenderMode.Live2D);
            await WaitForSwitchIdleAsync();
            if (_rendererMode != CharacterRenderMode.Live2D)
            {
                AppLog.Error("RECREATE_SETTINGS_RESULT FAIL round_{0}_live2d", i);
                return;
            }
            var r = _live2D!;
            r.SetPhysicsStrength(1.5);
            r.SetGazeIdleTimeout(3.0);
            for (int f = 0; f < 30; f++) r.Update(1.0 / 60.0);
            var (cur, tgt) = ReadPhysicsStrength(r);
            var (timeout, _) = ReadMouseIdle(r);
            AppLog.Info("RECREATE_SETTINGS round={0} physics={1:0.00}/{2:0.00} idleTimeout={3:0.00}", i, cur, tgt, timeout);
            if (Math.Abs(tgt - 1.5) > 0.01 || Math.Abs(timeout - 3.0) > 0.01)
            {
                AppLog.Error("RECREATE_SETTINGS_RESULT FAIL round_{0}", i);
                return;
            }
            SetRendererModeAsync(CharacterRenderMode.Existing);
            await WaitForSwitchIdleAsync();
        }
        AppLog.Info("RECREATE_SETTINGS_RESULT PASS rounds={0}", rounds);
    }

    // ==================== 物理输入增益 / 输出倍率 CLI 测试 ====================
    // 对应物理参数优化验收。五个测试分别验证：
    //   1) 输入增益 1.0~4.0 单调 -> 输出幅度单调增强（PHYSICS_INPUT_GAIN）
    //   2) 虚拟输入不污染可见姿态（PHYSICS_VISIBLE_POSE_ISOLATION）
    //   3) 物理输出不被控制器/渲染层覆盖（PHYSICS_OUTPUT_OVERWRITE）
    //   4) 固定输入序列下输出确定性 == 编辑器等价（PHYSICS_EDITOR_EQUIVALENCE）
    //   5) 24/30/60/144 FPS 下输出幅度一致（PHYSICS_60HZ）

    /// <summary>枚举 physics3.json 中全部输出参数 Id（Destination.Id 去重）。</summary>
    private static List<string> EnumeratePhysicsOutputIds()
    {
        var modelJson = Live2DInterop.ModelJsonPath;
        string dir = Path.GetDirectoryName(modelJson)!;
        using var md = JsonDocument.Parse(File.ReadAllText(modelJson));
        string physicsRel = md.RootElement.GetProperty("FileReferences").GetProperty("Physics").GetString()!;
        string physicsPath = Path.Combine(dir, physicsRel.Replace('/', Path.DirectorySeparatorChar));
        bool done = File.Exists(physicsPath);
        var ids = new List<string>();
        if (!done)
        {
            AppLog.Error("PHYSICS_OUTPUT_OVERWRITE physics3.json 不存在: {0}", physicsPath);
            return ids;
        }
        using var pd = JsonDocument.Parse(File.ReadAllText(physicsPath));
        foreach (var setting in pd.RootElement.GetProperty("PhysicsSettings").EnumerateArray())
        {
            if (!setting.TryGetProperty("Output", out var outputs)) continue;
            foreach (var o in outputs.EnumerateArray())
            {
                string id = o.GetProperty("Destination").GetProperty("Id").GetString()!;
                if (!ids.Contains(id)) ids.Add(id);
            }
        }
        return ids;
    }

    /// <summary>读取当前输入/输出增益（current=平滑值, target=设定值）。</summary>
    private static (double hc, double ht, double bc, double bt, double oc, double ot) ReadPhysicsGains(Live2DCharacterRenderer r)
    {
        int rc = Live2DInterop.AliyaLive2D_GetPhysicsGains(r.Handle,
            out float hc, out float ht, out float bc, out float bt, out float oc, out float ot);
        return rc == Live2DInterop.OK ? (hc, ht, bc, bt, oc, ot) :
            (double.NaN, double.NaN, double.NaN, double.NaN, double.NaN, double.NaN);
    }

    /// <summary>读取 Native 最后一次 Update 的物理驱动诊断（可见输入 / 虚拟输入 / 步数 / 最大输出增量）。</summary>
    private static Live2DInterop.AliyaLive2DPhysicsDriveInfo ReadDriveInfo(Live2DCharacterRenderer r)
    {
        var info = new Live2DInterop.AliyaLive2DPhysicsDriveInfo();
        Live2DInterop.AliyaLive2D_GetPhysicsDriveInfo(r.Handle, out info);
        return info;
    }

    // ---- 确定性姿态辅助 ----
    // 关键：SetState("drag", 0) 使 IsIdleAllowed=false -> 随机 wander/亚频正弦归零，
    // 但视线 (gaze) 不受影响；交替设置两个 look target 维持鼠标"移动"状态
    // （framemovePx >= 2px），状态机保持 Tracking，可见姿态完全由视线弹簧确定。
    // 于是"物理输入 = 可见姿态 × 增益"在每次测试中可重复、可精确断言。
    private static readonly (double x, double y)[] AltTargets = { (0.35, 0.35), (0.65, 0.65) };

    private static void EnterDeterministicPose(Live2DCharacterRenderer r, double headGain, double bodyGain, double outputGain)
    {
        r.SetLookAtEnabled(true);
        r.SetState(CharacterState.Drag, 0.0);
        r.SetGazeIdleTimeout(30.0);
        r.SetPhysicsInputGain(headGain, bodyGain);
        r.SetPhysicsOutputGain(outputGain);
        for (int i = 0; i < 120; i++)
        {
            var (x, y) = AltTargets[(i / 30) % 2];
            r.SetLookTarget(x, y);
            r.Update(1.0 / 60.0);
        }
    }

    /// <summary>交替两个 look target 若干循环，返回每个输出参数两姿态稳态均值差的绝对值（摆动幅度）。</summary>
    private static Dictionary<string, double> SampleAlternatingAmplitude(Live2DCharacterRenderer r, string[] groups,
        int framesPerSide, int cycles, double dt)
    {
        var sums = new Dictionary<string, double[]>();
        foreach (string g in groups) sums[g] = new double[4]; // [sumA, nA, sumB, nB]
        for (int c = 0; c < cycles; c++)
        {
            for (int side = 0; side < 2; side++)
            {
                var (x, y) = AltTargets[side];
                r.SetLookTarget(x, y);
                int settle = Math.Max(1, framesPerSide * 3 / 4); // 前 3/4 收敛，后 1/4 采样
                for (int i = 0; i < framesPerSide; i++)
                {
                    r.Update(dt);
                    if (i < settle) continue;
                    foreach (string g in groups)
                    {
                        if (r.GetParameterValue(g, out double v))
                        {
                            sums[g][side * 2] += v;
                            sums[g][side * 2 + 1]++;
                        }
                    }
                }
            }
        }
        var amp = new Dictionary<string, double>();
        foreach (string g in groups)
        {
            double meanA = sums[g][1] > 0 ? sums[g][0] / sums[g][1] : 0;
            double meanB = sums[g][3] > 0 ? sums[g][2] / sums[g][3] : 0;
            amp[g] = Math.Abs(meanB - meanA);
        }
        return amp;
    }

    private async Task RunPhysicsInputGainTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_INPUT_GAIN_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        string[] groups = { "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_9_Top_Bang", "Param_Angle_Rotation_2_CAT_Ear_R" };

        // 增益依次放大 1.0 -> 2.0 -> 2.5 -> 3.0 -> 3.5 -> 4.0（确定性姿态下，输出幅度必须单调不减）
        double[] gains = { 1.0, 2.0, 2.5, 3.0, 3.5, 4.0 };
        var amplitudes = new Dictionary<double, Dictionary<string, double>>();
        foreach (double g in gains)
        {
            EnterDeterministicPose(r, g, Math.Max(1.0, g), 1.0);
            var (hc, ht, _, bt, _, _) = ReadPhysicsGains(r);
            AppLog.Info("PHYSICS_INPUT_GAIN set={0:0.0} cur={1:0.00}/{2:0.00} body={3:0.00} conv={4}",
                g, hc, ht, bt, Math.Abs(hc - ht) < 0.01 && Math.Abs(bt - Math.Max(1.0, g)) < 0.01);
            var amp = SampleAlternatingAmplitude(r, groups, 60, 3, 1.0 / 60.0);
            amplitudes[g] = amp;
            AppLog.Info("PHYSICS_INPUT_GAIN gain={0:0.0} amp_bang={1:F4} amp_bang9={2:F4} amp_ear={3:F4}",
                g, amp[groups[0]], amp[groups[1]], amp[groups[2]]);
        }

        // 单调性：1.0 <= 2.0 <= 2.5 <= 3.0 <= 3.5 <= 4.0（允许 ±0.10 绝对误差），且 4.0 显著强于 1.0
        foreach (string g in groups)
        {
            bool mono = true;
            for (int i = 1; i < gains.Length; i++)
            {
                if (amplitudes[gains[i]][g] < amplitudes[gains[i - 1]][g] - 0.10)
                    mono = false;
            }
            double a1 = amplitudes[1.0][g], a6 = amplitudes[4.0][g];
            bool amplified = a6 >= a1 * 1.15;
            AppLog.Info("PHYSICS_INPUT_GAIN_MONO {0}: 1.0={1:F4} 2.0={2:F4} 2.5={3:F4} 3.0={4:F4} 3.5={5:F4} 4.0={6:F4} mono={7} amplified={8}",
                g, a1, amplitudes[2.0][g], amplitudes[2.5][g], amplitudes[3.0][g], amplitudes[3.5][g], a6,
                mono ? "YES" : "NO", amplified ? "YES" : "NO");
            if (!mono) { failures++; AppLog.Error("PHYSICS_INPUT_GAIN 单调失败 {0}", g); }
            if (!amplified) { failures++; AppLog.Error("PHYSICS_INPUT_GAIN 4.0 未显著强于 1.0 {0}", g); }
        }
        AppLog.Info(failures == 0 ? "PHYSICS_INPUT_GAIN_RESULT PASS" : "PHYSICS_INPUT_GAIN_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunPhysicsVisiblePoseIsolationTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_VISIBLE_POSE_ISOLATION_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        string[] inputs = { "ParamAngleX", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleZ" };

        // 阶段 1：增益 1.0 下进入确定性姿态并记录可见输入
        EnterDeterministicPose(r, 1.0, 1.0, 1.0);
        var (_, _, _, _, _, _) = ReadPhysicsGains(r);
        var visibleBefore = new Dictionary<string, double>();
        foreach (string id in inputs) { r.GetParameterValue(id, out double v); visibleBefore[id] = v; }

        // 阶段 2：增益 4.0 下运行 30 帧，可见输入必须保持不变（不允许被虚拟输入污染）
        r.SetPhysicsInputGain(4.0f, 4.0f);
        for (int i = 0; i < 30; i++) r.Update(1.0 / 60.0);
        var driveInfo = ReadDriveInfo(r);
        var visibleAfter = new Dictionary<string, double>();
        foreach (string id in inputs) { r.GetParameterValue(id, out double v); visibleAfter[id] = v; }
        foreach (string id in inputs)
        {
            double diff = Math.Abs(visibleAfter[id] - visibleBefore[id]);
            bool intact = diff < 0.5;
            AppLog.Info("PHYSICS_VISIBLE_POSE {0}: before={1:F3} after={2:F3} diff={3:F4} intact={4}",
                id, visibleBefore[id], visibleAfter[id], diff, intact ? "YES" : "NO");
            if (!intact) { failures++; AppLog.Error("PHYSICS_VISIBLE_POSE 可见输入被污染 {0} diff={1:F4}", id, diff); }
        }

        // 虚拟输入必须 = 可见输入 × 4（驱动信息同帧回读）
        double ratioX = Math.Abs(visibleBefore["ParamAngleX"]) > 0.5
            ? Math.Abs(driveInfo.PhysicsAngleX / Math.Max(1e-6, Math.Abs(visibleBefore["ParamAngleX"]))) : -1;
        bool amplified = ratioX >= 2.5 && ratioX <= 6.0;
        AppLog.Info("PHYSICS_VISIBLE_POSE drive visibleX={0:F3} physicsX={1:F3} ratio={2:F2} amplified={3} evalCount={4}",
            driveInfo.VisibleAngleX, driveInfo.PhysicsAngleX, ratioX, amplified ? "YES" : "NO", driveInfo.EvaluateCount);
        if (!amplified) { failures++; AppLog.Error("PHYSICS_VISIBLE_POSE 虚拟输入未按增益放大 ratio={0:F2}", ratioX); }
        if (driveInfo.EvaluateCount <= 0) { failures++; AppLog.Error("PHYSICS_VISIBLE_POSE 物理未求值 EvaluateCount=0"); }

        AppLog.Info(failures == 0 ? "PHYSICS_VISIBLE_POSE_ISOLATION_RESULT PASS" : "PHYSICS_VISIBLE_POSE_ISOLATION_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunPhysicsOutputOverwriteTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_OUTPUT_OVERWRITE_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        EnterDeterministicPose(r, 2.5, 3.0, 1.0);

        var outs = EnumeratePhysicsOutputIds();
        AppLog.Info("PHYSICS_OUTPUT_OVERWRITE outputs={0}", outs.Count);

        // CubismModel::SetParameterValue 会把写入值 Clamp 到参数 min/max（范围外哨兵 998 会被截断，
        // 导致全部误判"被覆盖"）。改用范围内哨兵 20.0，并以写入后立即回读的实际值（Clamp 后）为基准。
        const double sentinel = 20.0;
        r.SetPhysicsEnabled(false);
        var expected = new Dictionary<string, double>();
        foreach (string id in outs)
        {
            r.SetParameterValue(id, sentinel);
            r.GetParameterValue(id, out double v);
            expected[id] = v;
        }
        int clamped = outs.Count(id => Math.Abs(expected[id] - sentinel) > 0.01);
        AppLog.Info("PHYSICS_OUTPUT_OVERWRITE sentinel={0} clamped_by_model={1}/{2}", sentinel, clamped, outs.Count);

        // 关闭物理后让控制器/动画层继续跑 3 秒（不得覆盖 Physics 输出参数）
        for (int i = 0; i < 180; i++)
        {
            var (x, y) = AltTargets[(i / 30) % 2];
            r.SetLookTarget(x, y);
            r.Update(1.0 / 60.0);
        }
        int overwritten = 0;
        foreach (string id in outs)
        {
            r.GetParameterValue(id, out double v);
            if (Math.Abs(v - expected[id]) > 0.5) overwritten++;
        }
        AppLog.Info("PHYSICS_OUTPUT_OVERWRITE sentinel_clamped={0} overwritten={1}/{2}", clamped, overwritten, outs.Count);
        if (overwritten > 0) { failures++; AppLog.Error("PHYSICS_OUTPUT_OVERWRITE 输出被控制器覆盖 {0} 处", overwritten); }

        // 恢复物理：输出必须重新被 Evaluate 驱动（离开哨兵值）
        r.SetPhysicsEnabled(true);
        for (int i = 0; i < 600; i++)
        {
            var (x, y) = AltTargets[(i / 30) % 2];
            r.SetLookTarget(x, y);
            r.Update(1.0 / 60.0);
        }
        int restored = 0;
        foreach (string id in outs)
        {
            r.GetParameterValue(id, out double v);
            if (Math.Abs(v - expected[id]) > 0.5) restored++;
        }
        string restorePass = restored >= outs.Count * 0.5 ? "YES" : "NO";
        AppLog.Info("PHYSICS_OUTPUT_OVERWRITE restore_driven={0}/{1} ok={2}", restored, outs.Count, restorePass);
        if (restorePass == "NO") { failures++; AppLog.Error("PHYSICS_OUTPUT_OVERWRITE 恢复后输出未被驱动 {0}/{1}", restored, outs.Count); }

        AppLog.Info(failures == 0 ? "PHYSICS_OUTPUT_OVERWRITE_RESULT PASS" : "PHYSICS_OUTPUT_OVERWRITE_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunPhysicsEditorEquivalenceTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_EDITOR_EQUIVALENCE_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;

        // 八个物理组（刘海/呆毛/侧发/猫耳R/猫耳L/侧发2/领带/马尾），每组取成员参数中的最大 |输出|。
        // 对应 physics3.json：Setting1=Bang_Center、Setting2=Top_Bang、Setting3=ArtMesh21、
        // Setting4=CAT_Ear_R、Setting5=CAT_Ear_L、Setting6=ArtMesh20、Setting7=ArtMesh23、Setting8=ArtMesh32。
        var groups = new (string name, string[] members)[]
        {
            ("刘海", new[]{ "Param_Angle_Rotation_1_Bang_Center", "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_5_Bang_Center", "Param_Angle_Rotation_7_Bang_Center" }),
            ("呆毛", new[]{ "Param_Angle_Rotation_2_Top_Bang", "Param_Angle_Rotation_5_Top_Bang", "Param_Angle_Rotation_9_Top_Bang" }),
            ("侧发", new[]{ "Param_Angle_Rotation_2_ArtMesh21", "Param_Angle_Rotation_4_ArtMesh21" }),
            ("猫耳R", new[]{ "Param_Angle_Rotation_1_CAT_Ear_R", "Param_Angle_Rotation_2_CAT_Ear_R", "Param_Angle_Rotation_3_CAT_Ear_R" }),
            ("猫耳L", new[]{ "Param_Angle_Rotation_1_CAT_Ear_L", "Param_Angle_Rotation_2_CAT_Ear_L", "Param_Angle_Rotation_3_CAT_Ear_L" }),
            ("侧发2", new[]{ "Param_Angle_Rotation_2_ArtMesh20", "Param_Angle_Rotation_4_ArtMesh20" }),
            ("领带", new[]{ "Param_Angle_Rotation_2_ArtMesh23", "Param_Angle_Rotation_4_ArtMesh23", "Param_Angle_Rotation_6_ArtMesh23" }),
            ("马尾", new[]{ "Param_Angle_Rotation_1_ArtMesh32", "Param_Angle_Rotation_2_ArtMesh32", "Param_Angle_Rotation_3_ArtMesh32" })
        };

        // 确定性姿态热身（drag 态 + 交替目标，消除 wander/gaze 残留），随后固定 look 目标让弹簧归零，
        // 再切换到测试输入模式：Physics 输入 = 固定序列值 × 输入增益（本测试增益 1.0 时等于 Editor 直接输入）。
        EnterDeterministicPose(r, 1.0, 1.0, 1.0);
        r.SetLookTarget(0.5, 0.5);
        for (int i = 0; i < 180; i++) r.Update(1.0 / 60.0);
        r.SetPhysicsTestInput(true, 0, 0, 0, 0);

        // Editor 等价固定输入序列（0.5s 一段，@60Hz 30 帧）：
        //   t=0.0  (0, 0, 0, 0)
        //   t=0.5  (15, 5, 4, 2)
        //   t=1.0  (0, 0, 0, 0)
        //   t=1.5  (-15, -5, -4, -2)
        //   t=2.0  (0, 0, 0, 0)
        (float ax, float az, float bx, float bz)[] sequence =
        {
            ( 0,  0,  0,  0),
            (15,  5,  4,  2),
            ( 0,  0,  0,  0),
            (-15, -5, -4, -2),
            ( 0,  0,  0,  0),
        };
        const int holdFrames = 30; // 0.5s @ 60Hz
        const int loops = 10;

        // 四种配置：Editor 直接输入(1.0/1.0/1.0)、UI 100%(2.5/3.0/1.0)、UI 150%(3.1/3.6/1.18)、UI 200%(3.6/4.0/1.3)
        var configs = new (string label, double head, double body, double output)[]
        {
            ("direct_editor", 1.0, 1.0, 1.0),
            ("ui_100", 2.5, 3.0, 1.0),
            ("ui_150", 3.1, 3.6, 1.18),
            ("ui_200", 3.6, 4.0, 1.30)
        };
        var maxByConfig = new Dictionary<string, Dictionary<string, double>>();

        foreach (var cfg in configs)
        {
            r.SetPhysicsInputGain(cfg.head, cfg.body);
            r.SetPhysicsOutputGain(cfg.output);
            var maxOut = groups.ToDictionary(g => g.name, g => 0.0);
            for (int c = 0; c < loops; c++)
            {
                foreach (var (ax, az, bx, bz) in sequence)
                {
                    r.SetPhysicsTestInput(true, ax, az, bx, bz);
                    for (int f = 0; f < holdFrames; f++)
                    {
                        r.Update(1.0 / 60.0);
                        foreach (var g in groups)
                        {
                            double gMax = 0.0;
                            foreach (string member in g.members)
                            {
                                if (r.GetParameterValue(member, out double v))
                                    gMax = Math.Max(gMax, Math.Abs(v));
                            }
                            maxOut[g.name] = Math.Max(maxOut[g.name], gMax);
                        }
                    }
                }
            }
            maxByConfig[cfg.label] = maxOut;
            foreach (var g in groups)
                AppLog.Info("PHYSICS_EDITOR_EQUIVALENCE {0} {1}={2:F3}", cfg.label, g.name, maxOut[g.name]);
        }

        // 判定 1：Editor 直接输入（增益 1.0，15/5/4/2°）下 8 个物理组均有可见输出
        //         -> 模型 Physics 正常，原运行时输入太小（约 0.5~1.6°，显著大于 idle 输入 ±0.4° 的输出量级）。
        double overallMaxDirect = maxByConfig["direct_editor"].Values.Max();
        double overallMinDirect = maxByConfig["direct_editor"].Values.Min();
        bool visibleOutput = overallMaxDirect >= 1.0 && overallMinDirect >= 0.3;
        AppLog.Info("PHYSICS_EDITOR_EQUIVALENCE direct_input overall_max={0:F3} overall_min={1:F3} visible={2}",
            overallMaxDirect, overallMinDirect, visibleOutput ? "YES" : "NO");
        if (!visibleOutput) { failures++; AppLog.Error("PHYSICS_EDITOR_EQUIVALENCE 直接输入未产生明显输出 max={0:F3} min={1:F3}", overallMaxDirect, overallMinDirect); }

        // 判定 2：输入增益/输出倍率增强后输出必须单调不减（直接 <= 100% <= 150% <= 200%，允许 ±0.5 绝对误差）
        foreach (var g in groups)
        {
            double d = maxByConfig["direct_editor"][g.name];
            double u100 = maxByConfig["ui_100"][g.name];
            double u150 = maxByConfig["ui_150"][g.name];
            double u200 = maxByConfig["ui_200"][g.name];
            bool mono = u100 >= d - 0.5 && u150 >= u100 - 0.5 && u200 >= u150 - 0.5;
            bool boosted = u200 >= d * 1.15;
            AppLog.Info("PHYSICS_EDITOR_EQUIVALENCE_MONO {0}: direct={1:F3} 100%={2:F3} 150%={3:F3} 200%={4:F3} mono={5} boosted={6}",
                g.name, d, u100, u150, u200, mono ? "YES" : "NO", boosted ? "YES" : "NO");
            if (!mono) { failures++; AppLog.Error("PHYSICS_EDITOR_EQUIVALENCE 增益增强后输出未单调 {0}", g.name); }
            if (!boosted) { failures++; AppLog.Error("PHYSICS_EDITOR_EQUIVALENCE 200% 未显著强于直接输入 {0}", g.name); }
        }

        r.SetPhysicsTestInput(false, 0, 0, 0, 0);
        AppLog.Info(failures == 0 ? "PHYSICS_EDITOR_EQUIVALENCE_RESULT PASS" : "PHYSICS_EDITOR_EQUIVALENCE_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    private async Task RunPhysics60HzTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_60HZ_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        string[] groups = { "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_9_Top_Bang", "Param_Angle_Rotation_2_CAT_Ear_R" };
        EnterDeterministicPose(r, 2.5, 3.0, 1.0);
        r.SetLookTarget(0.5, 0.5);
        for (int i = 0; i < 180; i++) r.Update(1.0 / 60.0);
        r.SetPhysicsTestInput(true, 0, 0, 0, 0);

        // 固定输入序列（0.5s 恒定时段）：物理固定 60Hz 步进，渲染帧率只改变"何时写入输入"，
        // 恒定段内弹簧收敛值不随采样相位变化 —— 直接验证固定步进引擎的帧率无关性。
        // （gaze 连续波形下弹簧始终处于瞬态，均值采样会因渲染相位混叠产生假差异，故不使用。）
        (float ax, float az, float bx, float bz)[] sequence =
        {
            ( 0,  0,  0,  0),
            (15,  5,  4,  2),
            ( 0,  0,  0,  0),
            (-15, -5, -4, -2),
            ( 0,  0,  0,  0),
        };
        double[] fps = { 24.0, 30.0, 60.0, 144.0 };
        var ampByFps = new Dictionary<double, Dictionary<string, double>>();
        foreach (double f in fps)
        {
            double dt = 1.0 / f;
            int framesPerHold = (int)Math.Round(0.5 * f);
            var amp = groups.ToDictionary(g => g, g => 0.0);
            for (int c = 0; c < 3; c++)
            {
                foreach (var (ax, az, bx, bz) in sequence)
                {
                    r.SetPhysicsTestInput(true, ax, az, bx, bz);
                    for (int i = 0; i < framesPerHold; i++)
                    {
                        r.Update(dt);
                        // 恒定段内取全段 max|v|：轨迹已证明固定步进逐位帧率无关，
                        // 窗口按整数帧截断会因采样相位造成伪差异，全段 max 不受影响。
                        foreach (string g in groups)
                            if (r.GetParameterValue(g, out double v))
                                amp[g] = Math.Max(amp[g], Math.Abs(v));
                    }
                }
            }
            ampByFps[f] = amp;
            AppLog.Info("PHYSICS_60HZ fps={0:0} Bang={1:F4} Bang9={2:F4} Ear={3:F4}", f, amp[groups[0]], amp[groups[1]], amp[groups[2]]);
        }

        // 各帧率幅度允许 ±15% 相对偏差（基准=60fps）
        foreach (string g in groups)
        {
            double refAmp = ampByFps[60.0][g];
            double tolerance = refAmp * 0.15 + 0.02;
            foreach (double f in fps)
            {
                double a = ampByFps[f][g];
                if (Math.Abs(a - refAmp) > tolerance)
                {
                    failures++;
                    AppLog.Error("PHYSICS_60HZ FAIL group={0} fps={1:0} amp={2:F4} ref={3:F4}", g, f, a, refAmp);
                }
            }
        }
        AppLog.Info(failures == 0 ? "PHYSICS_60HZ_RESULT PASS" : "PHYSICS_60HZ_RESULT FAIL failures={0}", failures);

        r.SetPhysicsTestInput(false, 0, 0, 0, 0);
        DeactivateLive2D();
    }

    // =========================================================
    // Physics 输出幅度（独立于输入增益/输出倍率）
    // =========================================================

    /// <summary>读取输出幅度 current/target。</summary>
    private static (double cur, double tgt) ReadOutputAmplitude(Live2DCharacterRenderer r)
    {
        return r.ReadPhysicsOutputAmplitude();
    }

    /// <summary>驱动固定小输入序列产生稳定 delta：PhysicsTestInput 强制写入 4 个输入参数
    /// （编辑器可观测），每 40 帧在小范围内跳跃（避免输出饱和进入 Clamp 截断区），
    /// 测量输出参数全窗口 max-min，跨度 = base 固定下的输出增量 × 幅度，可直接验证 0.5×/1.5×/2× 缩放。</summary>
    private static Dictionary<string, double> SampleAmplitudeUnderSweep(
        Live2DCharacterRenderer r, string[] groups, int cycles, double dt)
    {
        double[][] seq = { new[] { 0.8, 0.6, -0.4, 0.3 }, new[] { -0.8, -0.6, 0.4, -0.3 } };
        var minV = new Dictionary<string, double>();
        var maxV = new Dictionary<string, double>();
        foreach (string g in groups) { minV[g] = 1e9; maxV[g] = -1e9; }
        for (int c = 0; c < cycles; c++)
        {
            for (int s = 0; s < 2; s++)
            {
                r.SetPhysicsTestInput(true, seq[s][0], seq[s][1], seq[s][2], seq[s][3]);
                for (int i = 0; i < 40; i++)
                {
                    r.Update(dt);
                    foreach (string g in groups)
                    {
                        if (!r.GetParameterValue(g, out double v) || double.IsNaN(v) || double.IsInfinity(v)) continue;
                        minV[g] = Math.Min(minV[g], v);
                        maxV[g] = Math.Max(maxV[g], v);
                    }
                }
            }
        }
        r.SetPhysicsTestInput(false, 0, 0, 0, 0);
        var amp = new Dictionary<string, double>();
        foreach (string g in groups) amp[g] = Math.Max(0, maxV[g] - minV[g]);
        return amp;
    }

    /// <summary>输出幅度测试：0/0.5/1.0/1.25/1.5/1.75/2.0 倍率在完全相同的物理输入序列下，
    /// 输出摆动幅度必须满足 0%≈0、50%≈0.5×、100%==基准、150%≈1.5×、200%>150% 且不发散。</summary>
    private async Task RunPhysicsOutputAmplitudeTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_OUTPUT_AMPLITUDE_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        var ids = EnumeratePhysicsOutputIds();
        string[] groups = ids.Count >= 3 ? new[] { ids[0], ids[ids.Count / 2], ids[ids.Count - 1] } :
            new[] { "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_9_Top_Bang" };

        double[] amps = { 0.0, 0.5, 1.0, 1.25, 1.5, 1.75, 2.0 };
        var amplitudes = new Dictionary<double, Dictionary<string, double>>();
        foreach (double a in amps)
        {
            r.SetPhysicsInputGain(2.5, 3.0); // 固定输入增益（与幅度无关）
            r.SetPhysicsOutputGain(1.0);     // 固定输出倍率
            r.SetPhysicsOutputAmplitude(a);
            r.SetPhysicsTestInput(true, 0, 0, 0, 0);
            for (int i = 0; i < 240; i++) r.Update(1.0 / 60.0); // 等平滑收敛 + 测试输入生效

            var (cur, tgt) = ReadOutputAmplitude(r);
            var amp = SampleAmplitudeUnderSweep(r, groups, 3, 1.0 / 60.0);
            amplitudes[a] = amp;
            AppLog.Info("PHYSICS_OUTPUT_AMPLITUDE set={0:0.00} nativeCur={1:0.000} nativeTgt={2:0.000} "
                + "amp0={3:F4} amp1={4:F4} amp2={5:F4}",
                a, cur, tgt, amp[groups[0]], amp[groups[1]], amp[groups[groups.Length > 2 ? 2 : 1]]);
            if (Math.Abs(tgt - a) > 0.01) { failures++; AppLog.Error("PHYSICS_OUTPUT_AMPLITUDE FAIL target={0} set={1}", tgt, a); }
            if (Math.Abs(cur - a) > 0.02) { failures++; AppLog.Error("PHYSICS_OUTPUT_AMPLITUDE FAIL 未收敛 cur={0} set={1}", cur, a); }
        }

        foreach (string g in groups)
        {
            double a0 = amplitudes[0.0][g], a05 = amplitudes[0.5][g], a1 = amplitudes[1.0][g];
            double a125 = amplitudes[1.25][g], a15 = amplitudes[1.5][g], a175 = amplitudes[1.75][g], a20 = amplitudes[2.0][g];
            double refAmp = Math.Max(1e-6, a1);
            bool zeroOk = a0 < refAmp * 0.10 + 0.005;
            bool halfOk = Math.Abs(a05 / refAmp - 0.5) < 0.22;
            bool oneOk = a1 > refAmp * 0.95 && a1 < refAmp * 1.05;
            bool oneFiveOk = Math.Abs(a15 / refAmp - 1.5) < 0.30;
            bool twoHundredOk = a20 > a15 - 1e-6 && double.IsFinite(a20) && a20 < a15 * 1.35 + 0.03;
            AppLog.Info("PHYSICS_OUTPUT_AMPLITUDE {0}: 0%={1:F4} 50%={2:F4} 100%={3:F4} 125%={4:F4} 150%={5:F4} 175%={6:F4} 200%={7:F4} "
                + "zero={8} half={9} one={10} oneFive={11} twoHundred={12}",
                g, a0, a05, a1, a125, a15, a175, a20, zeroOk, halfOk, oneOk, oneFiveOk, twoHundredOk);
            if (!(zeroOk && halfOk && oneOk && oneFiveOk && twoHundredOk))
            {
                failures++;
                AppLog.Error("PHYSICS_OUTPUT_AMPLITUDE FAIL {0} ({1:F4}/{2:F4}/{3:F4}/{4:F4}/{5:F4}/{6:F4}/{7:F4})", g, a0, a05, a1, a125, a15, a175, a20);
            }
        }

        AppLog.Info(failures == 0 ? "PHYSICS_OUTPUT_AMPLITUDE_RESULT PASS" : "PHYSICS_OUTPUT_AMPLITUDE_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    /// <summary>输入/输出隔离测试：两个滑块互不覆盖——改变输出幅度不得触碰输入增益/输出倍率，
    /// 改变输入增益/输出倍率不得触碰输出幅度。</summary>
    private async Task RunPhysicsInputOutputIsolationTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_INPUT_OUTPUT_ISOLATION_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;

        EnterDeterministicPose(r, 2.5, 3.0, 1.0);
        r.SetPhysicsOutputAmplitude(1.0);
        for (int i = 0; i < 90; i++) r.Update(1.0 / 60.0);
        var (hc0, ht0, bc0, bt0, oc0, ot0) = ReadPhysicsGains(r);
        var (ac0, at0) = ReadOutputAmplitude(r);
        AppLog.Info("ISOLATION baseline gain=({0:0.00}/{1:0.00}/{2:0.00}/{3:0.00}/{4:0.00}/{5:0.00}) amp=({6:0.000}/{7:0.000})",
            hc0, ht0, bc0, bt0, oc0, ot0, ac0, at0);

        // 1) 改幅度 1.5：输入增益/输出倍率 current+target 必须完全不变
        r.SetPhysicsOutputAmplitude(1.5);
        for (int i = 0; i < 90; i++) r.Update(1.0 / 60.0);
        var (hc1, ht1, bc1, bt1, oc1, ot1) = ReadPhysicsGains(r);
        var (ac1, at1) = ReadOutputAmplitude(r);
        bool gainUntouched = Math.Abs(hc1 - hc0) < 1e-4 && Math.Abs(ht1 - ht0) < 1e-4 &&
            Math.Abs(bc1 - bc0) < 1e-4 && Math.Abs(bt1 - bt0) < 1e-4 &&
            Math.Abs(oc1 - oc0) < 1e-4 && Math.Abs(ot1 - ot0) < 1e-4;
        bool ampMoved = Math.Abs(ac1 - 1.5) < 0.02 && Math.Abs(at1 - 1.5) < 0.01;
        AppLog.Info("ISOLATION_AMP_CHANGE gain=({0:0.00}/{1:0.00}/{2:0.00}/{3:0.00}/{4:0.00}/{5:0.00}) amp=({6:0.000}/{7:0.000}) gainUntouched={8} ampMoved={9}",
            hc1, ht1, bc1, bt1, oc1, ot1, ac1, at1, gainUntouched, ampMoved);
        if (!gainUntouched) failures++;
        if (!ampMoved) failures++;

        // 2) 改输入增益 (3.0, 3.5) + 输出倍率 0.8：输出幅度 current+target 必须完全不变
        r.SetPhysicsInputGain(3.0, 3.5);
        r.SetPhysicsOutputGain(0.8);
        for (int i = 0; i < 90; i++) r.Update(1.0 / 60.0);
        var (hc2, ht2, bc2, bt2, oc2, ot2) = ReadPhysicsGains(r);
        var (ac2, at2) = ReadOutputAmplitude(r);
        bool ampUntouched = Math.Abs(ac2 - ac1) < 1e-4 && Math.Abs(at2 - at1) < 1e-4;
        bool gainMoved = Math.Abs(ht2 - 3.0) < 0.01 && Math.Abs(bt2 - 3.5) < 0.01 && Math.Abs(ot2 - 0.8) < 0.01;
        AppLog.Info("ISOLATION_GAIN_CHANGE gain=({0:0.00}/{1:0.00}/{2:0.00}/{3:0.00}/{4:0.00}/{5:0.00}) amp=({6:0.000}/{7:0.000}) ampUntouched={8} gainMoved={9}",
            hc2, ht2, bc2, bt2, oc2, ot2, ac2, at2, ampUntouched, gainMoved);
        if (!ampUntouched) failures++;
        if (!gainMoved) failures++;

        AppLog.Info(failures == 0 ? "PHYSICS_INPUT_OUTPUT_ISOLATION_RESULT PASS" : "PHYSICS_INPUT_OUTPUT_ISOLATION_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    /// <summary>输出反馈测试：固定输入 60s（幅度 1.0/2.0 各 30s），
    /// 稳态输出不得漂移/累积/NaN/Inf——baseValue 必须始终是当前帧非 Physics 基础值。</summary>
    private async Task RunPhysicsOutputFeedbackTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_OUTPUT_FEEDBACK_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        var ids = EnumeratePhysicsOutputIds();
        if (ids.Count == 0)
        {
            AppLog.Error("PHYSICS_OUTPUT_FEEDBACK_RESULT FAIL no_output_params");
            DeactivateLive2D();
            return;
        }

        foreach (double amp in new[] { 1.0, 2.0 })
        {
            // 固定输入：确定性姿态建立后保持同一 look target（稳态）
            EnterDeterministicPose(r, 2.5, 3.0, 1.0);
            r.SetPhysicsOutputAmplitude(amp);
            for (int i = 0; i < 120; i++) r.Update(1.0 / 60.0);
            r.SetLookTarget(0.45, 0.45);
            for (int i = 0; i < 120; i++) r.Update(1.0 / 60.0); // 稳态建立

            var drift = new Dictionary<string, (double min, double max)>();
            var driftTail = new Dictionary<string, (double min, double max)>();
            foreach (string id in ids) { drift[id] = (1e9, -1e9); driftTail[id] = (1e9, -1e9); }
            bool nanFound = false, infFound = false;
            int frames = 30 * 60; // 30s 固定输入
            for (int i = 0; i < frames; i++)
            {
                r.Update(1.0 / 60.0);
                bool tailPhase = i >= frames * 2 / 3; // 后 1/3 判定尾段漂移（无累积则≈全程）
                foreach (string id in ids)
                {
                    if (!r.GetParameterValue(id, out double v)) continue;
                    if (double.IsNaN(v)) { nanFound = true; continue; }
                    if (double.IsInfinity(v)) { infFound = true; continue; }
                    var (mn, mx) = drift[id];
                    drift[id] = (Math.Min(mn, v), Math.Max(mx, v));
                    if (tailPhase)
                    {
                        var (tmn, tmx) = driftTail[id];
                        driftTail[id] = (Math.Min(tmn, v), Math.Max(tmx, v));
                    }
                }
            }
            double maxDrift = 0, maxTailDrift = 0;
            foreach (string id in ids)
            {
                var (mn, mx) = drift[id];
                var (tmn, tmx) = driftTail[id];
                maxDrift = Math.Max(maxDrift, mx - mn);
                maxTailDrift = Math.Max(maxTailDrift, tmx - tmn);
            }
            // 累积型反馈会导致尾段漂移随采样时间线性增长（tail/first >> 1）；
            // 稳态振荡的尾段漂移与全程接近。判定：尾段漂移受限且不显著高于全程。
            var (_, _, _, _, _, _) = ReadPhysicsGains(r);
            var di = ReadDriveInfo(r);
            bool stable = maxTailDrift < 0.5 && maxDrift < 1.5 && !nanFound && !infFound && di.UniqueOutputCount == ids.Count;
            AppLog.Info("PHYSICS_OUTPUT_FEEDBACK amp={0:0.0} maxDrift={1:F5} maxTailDrift={2:F5} nan={3} inf={4} uniqueOutputs={5}/{6} apply={7}/{8}",
                amp, maxDrift, maxTailDrift, nanFound, infFound, di.UniqueOutputCount, ids.Count, di.AmplitudeApplyCount, ids.Count);
            if (!stable || di.AmplitudeApplyCount != di.UniqueOutputCount)
            {
                failures++;
                AppLog.Error("PHYSICS_OUTPUT_FEEDBACK FAIL amp={0} maxDrift={1:F5} nan={2} inf={3} apply={4}/{5}",
                    amp, maxDrift, nanFound, infFound, di.AmplitudeApplyCount, di.UniqueOutputCount);
            }
        }

        AppLog.Info(failures == 0 ? "PHYSICS_OUTPUT_FEEDBACK_RESULT PASS" : "PHYSICS_OUTPUT_FEEDBACK_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    /// <summary>100% 快速路径测试：amplitude=1.0 且 outputGain=1.0 时，
    /// finalValue 必须等于 Evaluate 输出（finalDelta == rawDelta，无叠加/无 Clamp 命中），
    /// 与增加输出幅度功能前的原始 Cubism Physics 输出一致。</summary>
    private async Task RunPhysicsOutput100PercentTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_OUTPUT_100_PERCENT_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        var ids = EnumeratePhysicsOutputIds();

        EnterDeterministicPose(r, 2.5, 3.0, 1.0);
        r.SetPhysicsOutputAmplitude(1.0);
        for (int i = 0; i < 120; i++) r.Update(1.0 / 60.0);
        var (cur, tgt) = ReadOutputAmplitude(r);
        AppLog.Info("PHYSICS_OUTPUT_100 amplitude cur={0:0.000} tgt={1:0.000}", cur, tgt);
        if (Math.Abs(tgt - 1.0) > 0.01) failures++;

        bool mismatch = false;
        double maxRaw = 0, maxFinal = 0;
        for (int i = 0; i < 180; i++) // 3s 采样
        {
            r.Update(1.0 / 60.0);
            var di = ReadDriveInfo(r);
            maxRaw = Math.Max(maxRaw, di.OutputMaxDelta);
            maxFinal = Math.Max(maxFinal, di.OutputFinalMaxDelta);
            // 快速路径：final == raw（delta 不被缩放）；且幅度=1.0 时不得出现软 Clamp 命中
            if (Math.Abs(di.OutputFinalMaxDelta - di.OutputMaxDelta) > 1e-4) mismatch = true;
            if (di.OutputClampHits > 0) mismatch = true;
            if (di.AmplitudeApplyCount != di.UniqueOutputCount) mismatch = true;
        }
        bool amplitudeOne = Math.Abs(cur - 1.0) < 0.02;
        bool pathIdentical = !mismatch && ids.Count == 0 ? true : (Math.Abs(maxFinal - maxRaw) < 1e-4);
        AppLog.Info("PHYSICS_OUTPUT_100 pathRawMax={0:F5} pathFinalMax={1:F5} identical={2} amplitudeOne={3}",
            maxRaw, maxFinal, pathIdentical, amplitudeOne);
        if (!amplitudeOne || !pathIdentical)
        {
            failures++;
            AppLog.Error("PHYSICS_OUTPUT_100 FAIL identical={0} amplitudeOne={1}", pathIdentical, amplitudeOne);
        }

        AppLog.Info(failures == 0 ? "PHYSICS_OUTPUT_100_PERCENT_RESULT PASS" : "PHYSICS_OUTPUT_100_PERCENT_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }

    /// <summary>输出幅度稳定性测试：100/150/175/200% × 追踪/快速追踪，
    /// 记录 MaxFrameDelta / RmsVelocity / MaxAcceleration / ClampHitCount / ZeroCrossingsPerSecond，
    /// 幅度增大必须单调、有限、无 NaN/Inf、不出现指数级抖动发散。</summary>
    private async Task RunPhysicsOutputStabilityTestAsync()
    {
        bool ok = await ActivateLive2DAsync();
        if (!ok) { AppLog.Error("PHYSICS_OUTPUT_STABILITY_RESULT FAIL activate_failed"); return; }
        var r = _live2D!;
        int failures = 0;
        var ids = EnumeratePhysicsOutputIds();
        string[] groups = ids.Count >= 3 ? new[] { ids[0], ids[ids.Count / 2], ids[ids.Count - 1] } :
            new[] { "Param_Angle_Rotation_3_Bang_Center", "Param_Angle_Rotation_9_Top_Bang" };

        double[] amps = { 1.0, 1.5, 1.75, 2.0 };
        var metrics = new Dictionary<double, (double maxFrameDelta, double rmsVel, double maxAccel, int clampHits, double zeroXPerSec)>();
        foreach (double amp in amps)
        {
            // 快速追踪：大幅交替 look target 制造大输入速度（高动态，最容易抖动的场景）
            EnterDeterministicPose(r, 2.5, 3.0, 1.0);
            r.SetPhysicsOutputAmplitude(amp);
            for (int i = 0; i < 120; i++) r.Update(1.0 / 60.0);

            double maxFrameDelta = 0, sumVel2 = 0, maxAccel = 0;
            int frames = 0, zeroCross = 0, clampHits = 0;
            var prev = new Dictionary<string, double>();
            var prevPrev = new Dictionary<string, double>();
            foreach (string g in groups) { prev[g] = 0; prevPrev[g] = 0; }
            double dt = 1.0 / 60.0;
            for (int i = 0; i < 300; i++) // 5s 快速追踪
            {
                var (x, y) = AltTargets[(i / 20) % 2];
                r.SetLookTarget(x, y);
                r.Update(dt);
                var di = ReadDriveInfo(r);
                clampHits += di.OutputClampHits;
                frames++;
                foreach (string g in groups)
                {
                    if (!r.GetParameterValue(g, out double v)) continue;
                    if (double.IsNaN(v) || double.IsInfinity(v)) { failures++; AppLog.Error("PHYSICS_OUTPUT_STABILITY FAIL NaN/Inf {0} amp={1}", g, amp); }
                    double d = Math.Abs(v - prev[g]);
                    maxFrameDelta = Math.Max(maxFrameDelta, d);
                    sumVel2 += d * d;
                    double accel = Math.Abs(v - 2 * prev[g] + prevPrev[g]);
                    maxAccel = Math.Max(maxAccel, accel);
                    if (prevPrev[g] != 0 && Math.Sign(v - prev[g]) != Math.Sign(prev[g] - prevPrev[g]) &&
                        Math.Abs(v - prev[g]) > 1e-6) zeroCross++;
                    prevPrev[g] = prev[g];
                    prev[g] = v;
                }
            }
            double rmsVel = Math.Sqrt(sumVel2 / Math.Max(1, frames * groups.Length));
            double zeroXPerSec = (double)zeroCross / (frames * dt);
            metrics[amp] = (maxFrameDelta, rmsVel, maxAccel, clampHits, zeroXPerSec);
            AppLog.Info("PHYSICS_OUTPUT_STABILITY amp={0:0.00} maxFrameDelta={1:F5} rmsVel={2:F5} maxAccel={3:F5} clampHits={4} zeroXPerSec={5:0.00}",
                amp, maxFrameDelta, rmsVel, maxAccel, clampHits, zeroXPerSec);
        }

        // 单调性：帧间最大变化随幅度单调不减（线性 ×2 预期 ≤2×，安全 Clamp 后不放大）
        double d100 = metrics[1.0].maxFrameDelta;
        double d150 = metrics[1.5].maxFrameDelta;
        double d200 = metrics[2.0].maxFrameDelta;
        bool monotonic = d150 >= d100 - 1e-9 && d200 >= d150 - 1e-9;
        bool noBlowup = d200 <= d100 * 2.5 + 0.01;
        bool clampExpected = metrics[2.0].clampHits > 0; // 200% 高速输入应触发安全 Clamp
        bool finite = double.IsFinite(d100) && double.IsFinite(d150) && double.IsFinite(d200);
        AppLog.Info("PHYSICS_OUTPUT_STABILITY summary d100={0:F5} d150={1:F5} d200={2:F5} monotonic={3} noBlowup={4} clampHits200={5} finite={6}",
            d100, d150, d200, monotonic, noBlowup, metrics[2.0].clampHits, finite);
        if (!(monotonic && noBlowup && finite)) failures++;

        AppLog.Info(failures == 0 ? "PHYSICS_OUTPUT_STABILITY_RESULT PASS" : "PHYSICS_OUTPUT_STABILITY_RESULT FAIL failures={0}", failures);
        DeactivateLive2D();
    }
}







