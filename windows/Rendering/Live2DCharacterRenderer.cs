using System.Text;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace AliyaPet.Rendering;

/// <summary>
/// Live2D 渲染器：Cubism Native + D3D11 离屏渲染 + CPU 读回 + WriteableBitmap 呈现。
/// 生命周期：
///   InitializeAsync（后台线程做 Native 初始化）→ Start（UI 定时器驱动帧循环）
///   → Pause/Resume（保留资源，用于模式切换缓存）→ Dispose（应用退出）。
/// 线程规则：Native Create/LoadModel/AttachWindow 在后台线程；Update/Render/Readback 在 UI 线程；
///          WriteableBitmap 仅在 UI 线程创建/更新；Destroy 与渲染帧循环串行化。
/// </summary>
public sealed class Live2DCharacterRenderer : ICharacterRenderer
{
    private IntPtr _handle;
    private readonly Image _hostImage;
    private readonly IntPtr _parentHwnd;
    private WriteableBitmap? _bitmap;
    private IntPtr _pixelBuffer;
    private int _bufferBytes;
    private int _widthPx;
    private int _heightPx;
    private double _dpiScaleX = 1.0;
    private double _dpiScaleY = 1.0;
    private bool _disposed;
    private bool _attached;
    private bool _lookAtEnabled = true;
    private double _scale = 1.0;
    private double _lipSyncCurrent;
    private bool _lipSyncEnabled = true;
    /// <summary>测试替身：模拟缺失的口型导出符号（仅 --lip-sync-missing-export-test 使用）。</summary>
    public static bool SimulateMissingLipSyncExport;
    /// <summary>诊断返回：开启后每 250ms 回读 Native 设置并记录 LIVE2D_SETTINGS_READBACK 日志。</summary>
    public static bool DiagnosticsEnabled = false;
    private DateTime _lastDiagLogUtc = DateTime.MinValue;

    /// <summary>诊断：口型当前是否启用（容错降级后为 false）。</summary>
    public bool IsLipSyncEnabled => _lipSyncEnabled;
    private DateTime _lastFrameTime = DateTime.UtcNow;
    private readonly DispatcherTimer _renderTimer;
    private bool _running;

    // 帧性能指标（用于 Readback/WriteableBitmap 性能数据）
    private readonly List<double> _frameMs = new();
    private readonly List<double> _updateMs = new();
    private readonly List<double> _renderMs = new();
    private readonly List<double> _readbackMs = new();
    private readonly List<double> _bitmapMs = new();
    private readonly object _metricsGate = new();
    private DateTime _metricsStart = DateTime.UtcNow;
    private int _metricsFrames;

    public Live2DCharacterRenderer(Image hostImage, IntPtr parentHwnd)
    {
        _hostImage = hostImage ?? throw new ArgumentNullException(nameof(hostImage));
        _parentHwnd = parentHwnd;
        _renderTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
        _renderTimer.Tick += (_, _) => RenderFrame();
    }

    public IntPtr Handle => _handle;
    public bool IsReady => _handle != IntPtr.Zero && _attached;
    public bool LookAtEnabled { get => _lookAtEnabled; set => SetLookAtEnabled(value); }
    public int WidthPx => _widthPx;
    public int HeightPx => _heightPx;

    /// <summary>后台线程执行 Native 初始化（Create/LoadModel/AttachWindow）。调用方须在 UI 线程 await。</summary>
    public async Task InitializeAsync(string modelJsonPath, int widthDip, int heightDip, double dpiScaleX, double dpiScaleY)
    {
        EnsureNotDisposed();
        _dpiScaleX = dpiScaleX;
        _dpiScaleY = dpiScaleY;
        int w = Math.Max(1, (int)Math.Ceiling(widthDip * dpiScaleX));
        int h = Math.Max(1, (int)Math.Ceiling(heightDip * dpiScaleY));

        var missing = Live2DInterop.PrefetchNativeExports(out var dllPath, out var dllVersion);
        if (missing.Count > 0)
        {
            AppLog.Error($"Live2D Native 导出缺失: {string.Join(", ", missing)}");
            AppLog.Error($"DLL 路径: {dllPath}, 版本: {dllVersion}");
            throw new InvalidOperationException("Live2D Native 导出缺失: " + string.Join(", ", missing));
        }

        await Task.Run(() =>
        {
            _handle = Live2DInterop.AliyaLive2D_Create();
            Live2DInterop.CheckApiVersion();
            if (_handle == IntPtr.Zero)
                throw new InvalidOperationException("AliyaLive2D_Create 失败：" + Live2DInterop.GetLastError(IntPtr.Zero));
            int rc = Live2DInterop.AliyaLive2D_SetAssetDirectory(_handle, AppContext.BaseDirectory);
            if (rc != Live2DInterop.OK)
                throw new InvalidOperationException("SetAssetDirectory 失败 rc=" + rc + "：" + Live2DInterop.GetLastError(_handle));

            rc = Live2DInterop.AliyaLive2D_LoadModel(_handle, modelJsonPath);
            if (rc != Live2DInterop.OK)
                throw new InvalidOperationException("LoadModel 失败 rc=" + rc + "：" + Live2DInterop.GetLastError(_handle));

            rc = Live2DInterop.AliyaLive2D_AttachWindow(_handle, _parentHwnd, w, h);
            if (rc != Live2DInterop.OK)
                throw new InvalidOperationException("AttachWindow 失败 rc=" + rc + "：" + Live2DInterop.GetLastError(_handle));
            _attached = true;
            _widthPx = w;
            _heightPx = h;
        });

        // 回到 UI 线程创建像素缓冲区与 WriteableBitmap
        _bufferBytes = _widthPx * _heightPx * 4;
        if (_pixelBuffer != IntPtr.Zero)
            Marshal.FreeHGlobal(_pixelBuffer);
        _pixelBuffer = Marshal.AllocHGlobal(_bufferBytes);
        _bitmap = new WriteableBitmap(_widthPx, _heightPx, 96 * dpiScaleX, 96 * dpiScaleY, PixelFormats.Pbgra32, null);
        _hostImage.Source = _bitmap;
    }

    public void Start()
    {
        if (_running) return;
        _running = true;
        _lastFrameTime = DateTime.UtcNow;
        _metricsStart = DateTime.UtcNow;
        _metricsFrames = 0;
        lock (_metricsGate) { _frameMs.Clear(); _updateMs.Clear(); _renderMs.Clear(); _readbackMs.Clear(); _bitmapMs.Clear(); }
        _renderTimer.Start();
        _hostImage.Visibility = Visibility.Visible;
    }

    public void Update(double deltaSeconds)
    {
        if (_handle == IntPtr.Zero || !_attached) return;
        Live2DInterop.AliyaLive2D_Update(_handle, deltaSeconds);
        if (DiagnosticsEnabled && (DateTime.UtcNow - _lastDiagLogUtc).TotalSeconds >= 0.25)
        {
            _lastDiagLogUtc = DateTime.UtcNow;
            LogRuntimeSettingsReadback();
        }
        if (_lipSyncCurrent > 0.0001 && _lipSyncEnabled)
        {
            try
            {
                _lipSyncCurrent = Math.Max(0, _lipSyncCurrent - deltaSeconds * 0.6);
                int rc = Live2DInterop.AliyaLive2D_SetLipSyncValue(_handle, _lipSyncCurrent);
                if (rc == Live2DInterop.ErrUnsupported)
                {
                    _lipSyncEnabled = false;
                    AppLog.Warn("Live2D 模型不含 ParamMouthOpenY，已禁用口型功能");
                }
            }
            catch (EntryPointNotFoundException)
            {
                _lipSyncEnabled = false;
            }
            catch (DllNotFoundException)
            {
                _lipSyncEnabled = false;
            }
        }
    }

    private void RenderFrame()
    {
        if (_disposed || _handle == IntPtr.Zero || _bitmap is null || _pixelBuffer == IntPtr.Zero)
            return;

        var now = DateTime.UtcNow;
        double intervalMs = (now - _lastFrameTime).TotalMilliseconds;
        var delta = Math.Clamp((now - _lastFrameTime).TotalSeconds, 0.001, 0.1);
        _lastFrameTime = now;
        PettingPerfDiagnostics.OnFrame(intervalMs);

        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();

            Update(delta);
            sw.Stop();
            double updateMs = sw.Elapsed.TotalMilliseconds;

            sw.Restart();
            int rcRender = Live2DInterop.AliyaLive2D_Render(_handle);
            sw.Stop();
            double renderMs = sw.Elapsed.TotalMilliseconds;

            sw.Restart();
            int rc = Live2DInterop.AliyaLive2D_CopyFramePixels(_handle, _pixelBuffer, _widthPx * 4);
            sw.Stop();
            double readbackMs = sw.Elapsed.TotalMilliseconds;

            if (rc == Live2DInterop.OK)
            {
                sw.Restart();
                _bitmap.Lock();
                _bitmap.WritePixels(new Int32Rect(0, 0, _widthPx, _heightPx), _pixelBuffer, _bufferBytes, _widthPx * 4);
                _bitmap.AddDirtyRect(new Int32Rect(0, 0, _widthPx, _heightPx));
                _bitmap.Unlock();
                sw.Stop();
                double bitmapMs = sw.Elapsed.TotalMilliseconds;

                _metricsFrames++;
                lock (_metricsGate)
                {
                    _frameMs.Add((now - _lastFrameTime).TotalMilliseconds);
                    _updateMs.Add(updateMs);
                    _renderMs.Add(renderMs);
                    _readbackMs.Add(readbackMs);
                    _bitmapMs.Add(bitmapMs);
                    // 限制指标窗口，避免每帧列表无限增长（每帧 5 次装箱分配）
                    if (_frameMs.Count > 900)
                    {
                        _frameMs.RemoveRange(0, 300);
                        _updateMs.RemoveRange(0, 300);
                        _renderMs.RemoveRange(0, 300);
                        _readbackMs.RemoveRange(0, 300);
                        _bitmapMs.RemoveRange(0, 300);
                    }
                }
            }
            else if (rcRender != Live2DInterop.OK)
            {
                AppLog.Error("Live2D Render/CopyFramePixels 失败 rc={0}", rc);
            }
        }
        catch (Exception ex)
        {
            AppLog.Error("Live2D RenderFrame 失败: {0}", ex);
        }
    }

    /// <summary>读取最近一段时间的帧性能指标（P50/P95/P99）。</summary>
    public void ReportMetrics()
    {
        lock (_metricsGate)
        {
            double fps = _metricsFrames > 0 ? _metricsFrames / Math.Max(0.001, (DateTime.UtcNow - _metricsStart).TotalSeconds) : 0;
            AppLog.Info("Live2D 性能: fps≈{0:0.#} frames={1} | Update P50={2:0.000} P95={3:0.000} | Render P50={4:0.000} P95={5:0.000} | Readback P50={6:0.000} P95={7:0.000} | Bitmap P50={8:0.000} P95={9:0.000} ms",
                fps, _metricsFrames,
                Percentile(_updateMs, 0.50), Percentile(_updateMs, 0.95),
                Percentile(_renderMs, 0.50), Percentile(_renderMs, 0.95),
                Percentile(_readbackMs, 0.50), Percentile(_readbackMs, 0.95),
                Percentile(_bitmapMs, 0.50), Percentile(_bitmapMs, 0.95));
        }
    }

    private static double Percentile(List<double> values, double p)
    {
        if (values.Count == 0) return 0;
        var s = new List<double>(values);
        s.Sort();
        int idx = Math.Min(s.Count - 1, (int)(s.Count * p));
        return s[idx];
    }

    public void Resize(int widthDip, int heightDip, double dpiScaleX, double dpiScaleY)
    {
        if (_handle == IntPtr.Zero) return;
        _dpiScaleX = dpiScaleX;
        _dpiScaleY = dpiScaleY;
        int w = Math.Max(1, (int)Math.Ceiling(widthDip * dpiScaleX));
        int h = Math.Max(1, (int)Math.Ceiling(heightDip * dpiScaleY));
        if (w == _widthPx && h == _heightPx && _bitmap != null)
            return;

        int rc;
        if (_attached)
        {
            rc = Live2DInterop.AliyaLive2D_SetViewport(_handle, w, h);
            if (rc != Live2DInterop.OK)
                throw new InvalidOperationException("SetViewport 失败 rc=" + rc + "：" + Live2DInterop.GetLastError(_handle));
        }
        else
        {
            rc = Live2DInterop.AliyaLive2D_AttachWindow(_handle, _parentHwnd, w, h);
            if (rc != Live2DInterop.OK)
                throw new InvalidOperationException("AttachWindow 失败 rc=" + rc + "：" + Live2DInterop.GetLastError(_handle));
            _attached = true;
        }

        _widthPx = w;
        _heightPx = h;
        _bufferBytes = w * h * 4;
        if (_pixelBuffer != IntPtr.Zero)
            Marshal.FreeHGlobal(_pixelBuffer);
        _pixelBuffer = Marshal.AllocHGlobal(_bufferBytes);
        _bitmap = new WriteableBitmap(w, h, 96 * dpiScaleX, 96 * dpiScaleY, PixelFormats.Pbgra32, null);
        _hostImage.Source = _bitmap;
    }

    public void SetScale(double scale)
    {
        _scale = scale;
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetScale(_handle, scale);
    }

    public void SetOpacity(double opacity)
    {
        _hostImage.Opacity = Math.Clamp(opacity, 0, 1);
    }

    public void SetState(CharacterState state, double intensity)
    {
        if (_handle == IntPtr.Zero || !_attached) return;
        string name = state switch
        {
            CharacterState.Move => "move",
            CharacterState.Drag => "drag",
            CharacterState.Click => "click",
            CharacterState.Sleep => "sleep",
            CharacterState.Wake => "wake",
            CharacterState.Entrance => "entrance",
            CharacterState.Exit => "exit",
            _ => "idle"
        };
        Live2DInterop.AliyaLive2D_SetState(_handle, name, intensity);
    }

    public void PlayAction(string actionName)
    {
        if (_handle == IntPtr.Zero || !_attached) return;
        Live2DInterop.AliyaLive2D_PlayAction(_handle, actionName);
    }

    public void SetExpression(string expressionName)
    {
        _ = expressionName;
    }

    public void SetLookTarget(double x01, double y01)
    {
        if (_handle == IntPtr.Zero || !_attached || !_lookAtEnabled) return;
        Live2DInterop.AliyaLive2D_SetLookTarget(_handle, x01, y01);
    }

    /// <summary>设置原始视线输入（-1..1，以脸部中心为锚点，reach 像素归一化）。</summary>
    public void SetGazeRawInput(double x, double y)
    {
        if (_handle == IntPtr.Zero || !_attached || !_lookAtEnabled) return;
        Live2DInterop.AliyaLive2D_SetGazeRawInput(_handle, x, y);
    }

    /// <summary>设置头部安全比例（X/Y/Z，0.05~1.0）。</summary>
    public void SetGazeHeadRange(double x, double y, double z)
    {
        if (_handle == IntPtr.Zero) return;
        Live2DInterop.AliyaLive2D_SetGazeHeadRange(_handle, (float)x, (float)y, (float)z);
    }

    public (double x, double y, double z) GetGazeHeadRange()
    {
        if (_handle == IntPtr.Zero) return (double.NaN, double.NaN, double.NaN);
        int rc = Live2DInterop.AliyaLive2D_GetGazeHeadRange(_handle,
            out float x, out float y, out float z);
        return rc == Live2DInterop.OK ? (x, y, z) : (double.NaN, double.NaN, double.NaN);
    }

    /// <summary>设置头部跟随总幅度（0.2~1.0，默认 0.9）。</summary>
    public void SetGazeHeadFollowAmount(double amount)
    {
        if (_handle == IntPtr.Zero) return;
        Live2DInterop.AliyaLive2D_SetGazeHeadFollowAmount(_handle, (float)amount);
    }

    public (double cur, double tgt) GetGazeHeadFollowAmount()
    {
        if (_handle == IntPtr.Zero) return (double.NaN, double.NaN);
        int rc = Live2DInterop.AliyaLive2D_GetGazeHeadFollowAmount(_handle, out float cur, out float tgt);
        return rc == Live2DInterop.OK ? (cur, tgt) : (double.NaN, double.NaN);
    }

    internal Live2DInterop.AliyaLive2DGazeDiagnostics GetGazeDiagnostics()
    {
        var info = new Live2DInterop.AliyaLive2DGazeDiagnostics();
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_GetGazeDiagnostics(_handle, out info);
        return info;
    }

    /// <summary>读取模型参数当前值（供自动化测试断言物理输出变化）。</summary>
    public bool GetParameterValue(string id, out double value)
    {
        value = 0;
        if (_handle == IntPtr.Zero) return false;
        try
        {
            return Live2DInterop.AliyaLive2D_GetParameterValue(_handle, id, out value) == Live2DInterop.OK;
        }
        catch
        {
            return false;
        }
    }

    public void ClearLookTarget()
    {
        if (_handle == IntPtr.Zero) return;
        Live2DInterop.AliyaLive2D_ClearLookTarget(_handle);
    }

    public void SetLookAtEnabled(bool enabled)
    {
        _lookAtEnabled = enabled;
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetLookAtEnabled(_handle, enabled ? 1 : 0);
    }

    public void SetLipSyncValue(double value)
    {
        _lipSyncCurrent = Math.Clamp(value, 0, 1);
        if (_handle == IntPtr.Zero || !_lipSyncEnabled) return;
        // 测试替身：模拟缺失导出符号（与真实 EntryPointNotFoundException 相同的托管路径）。
        try
        {
            if (SimulateMissingLipSyncExport)
                throw new System.EntryPointNotFoundException("Simulated missing AliyaLive2D_SetLipSyncValue (test stub)");
            int rc = Live2DInterop.AliyaLive2D_SetLipSyncValue(_handle, _lipSyncCurrent);
            if (rc == Live2DInterop.ErrUnsupported)
            {
                _lipSyncEnabled = false;
                AppLog.Warn("Live2D 模型不含 ParamMouthOpenY，已禁用口型功能");
            }
        }
        catch (EntryPointNotFoundException)
        {
            _lipSyncEnabled = false;
            AppLog.Error("Live2D SetLipSyncValue 接口缺失，已禁用口型功能");
        }
        catch (DllNotFoundException)
        {
            _lipSyncEnabled = false;
            AppLog.Error("Live2D Native DLL 缺失，已禁用口型功能");
        }
    }
    public bool HitTest(double xDip, double yDip)
    {
        if (_handle == IntPtr.Zero || !_attached) return false;
        return Live2DInterop.AliyaLive2D_HitTest(_handle, xDip * _dpiScaleX, yDip * _dpiScaleY) == 1;
    }

    public void SetGazeSpeed(double multiplier)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetGazeSpeed(_handle, Math.Clamp(multiplier, 0.5, 5));
    }

    // ---- 物理效果滑块映射 ----
    // UI 滑块 0%~200% 不再线性映射为输出倍率 0~2；
    // 同时映射为：Physics 输入增益（虚拟输入 = 可见姿态 × 增益）+ 小范围输出倍率（上限 1.4）。
    // 锚点：(ui, headInputGain, bodyInputGain, outputGain)
    //   0%   -> (1.0, 1.2, 0.0)   100% -> (2.5, 3.0, 1.0)
    //   50%  -> (1.6, 1.9, 0.55)  150% -> (3.1, 3.6, 1.18)
    //   200% -> (3.6, 4.0, 1.30)  身体增益 = 头部 × 1.2（clamp 4.0）
    public static readonly (double ui, double head, double body, double output)[] PhysicsGainMap =
    {
        (0.00, 1.0, 1.2, 0.00),
        (0.50, 1.6, 1.9, 0.55),
        (1.00, 2.5, 3.0, 1.00),
        (1.50, 3.1, 3.6, 1.18),
        (2.00, 3.6, 4.0, 1.30)
    };

    public static (double head, double body, double output) MapPhysicsStrength(double ui)
    {
        ui = Math.Clamp(ui, 0.0, 2.0);
        for (int i = 1; i < PhysicsGainMap.Length; i++)
        {
            var lo = PhysicsGainMap[i - 1];
            var hi = PhysicsGainMap[i];
            if (ui <= hi.ui)
            {
                double t = (ui - lo.ui) / Math.Max(1e-9, hi.ui - lo.ui);
                return (
                    lo.head + (hi.head - lo.head) * t,
                    lo.body + (hi.body - lo.body) * t,
                    lo.output + (hi.output - lo.output) * t);
            }
        }
        return (2.5, 3.0, 1.0);
    }

    /// <summary>应用物理效果强度（UI 0~2）：按映射表同时设置输入增益与输出倍率。</summary>
    public void SetPhysicsStrength(double strength)
    {
        if (_handle == IntPtr.Zero)
            return;
        var (head, body, output) = MapPhysicsStrength(strength);
        Live2DInterop.AliyaLive2D_SetPhysicsStrength(_handle, (float)Math.Clamp(strength, 0.0, 2.0));
        Live2DInterop.AliyaLive2D_SetPhysicsInputGain(_handle, (float)head, (float)body);
        Live2DInterop.AliyaLive2D_SetPhysicsOutputGain(_handle, (float)output);
    }

    public void SetPhysicsInputGain(double head, double body)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetPhysicsInputGain(_handle, (float)head, (float)body);
    }

    public void SetPhysicsOutputGain(double gain)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetPhysicsOutputGain(_handle, (float)gain);
    }

    /// <summary>设置物理输出幅度（UI 0%~200% → 倍率 0.0~2.0）。与输入增益/输出倍率完全分离。</summary>
    public void SetPhysicsOutputAmplitude(double amplitude)
    {
        if (_handle == IntPtr.Zero)
            return;
        double clamped = Math.Clamp(amplitude, 0.0, 2.0);
        Live2DInterop.AliyaLive2D_SetPhysicsOutputAmplitude(_handle, (float)clamped);
        int rc = Live2DInterop.AliyaLive2D_GetPhysicsOutputAmplitude(_handle, out float cur, out float tgt);
        AppLog.Info("PHYSICS_OUTPUT_AMPLITUDE_SET Requested={0:0.00} NativeTarget={1:0.00} NativeCurrent={2:0.00}",
            clamped, rc == Live2DInterop.OK ? tgt : -1, rc == Live2DInterop.OK ? cur : -1);
    }

    /// <summary>读取物理输出幅度当前生效值与目标值。(current, target)</summary>
    public (double current, double target) ReadPhysicsOutputAmplitude()
    {
        if (_handle == IntPtr.Zero)
            return (double.NaN, double.NaN);
        int rc = Live2DInterop.AliyaLive2D_GetPhysicsOutputAmplitude(_handle, out float cur, out float tgt);
        return rc == Live2DInterop.OK ? ((double)cur, (double)tgt) : (double.NaN, double.NaN);
    }

    public void SetPhysicsEnabled(bool enabled)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetPhysicsEnabled(_handle, enabled ? 1 : 0);
    }

    /// <summary>设置 Physics 测试输入模式（编辑器等价性测试用）：固定角度序列直接驱动 Physics 输入。</summary>
    public void SetPhysicsTestInput(bool enabled, double angleX, double angleZ, double bodyAngleX, double bodyAngleZ)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetPhysicsTestInput(_handle, enabled ? 1 : 0,
                (float)angleX, (float)angleZ, (float)bodyAngleX, (float)bodyAngleZ);
    }

    public bool SetParameterValue(string id, double value)
    {
        if (_handle == IntPtr.Zero) return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetParameterValue(_handle, id, value) == Live2DInterop.OK;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 检测当前模型真实嘴部参数（ParamMouthOpenY / ParamMouthForm）及其范围。
    /// 旧版 Native 无对应导出时回退为 GetParameterValue 检测，不抛错。
    /// </summary>
    public (bool hasOpenY, bool hasForm, double openYMin, double openYMax, double formMin, double formMax) GetMouthParamInfo()
    {
        if (_handle == IntPtr.Zero)
            return (false, false, 0, 1, -1, 1);
        try
        {
            if (Live2DInterop.AliyaLive2D_GetMouthParamInfo(_handle, out var info) == Live2DInterop.OK)
                return (info.HasOpenY != 0, info.HasForm != 0, info.OpenYMin, info.OpenYMax, info.FormMin, info.FormMax);
        }
        catch
        {
            // 旧 Native 缺少导出：走 GetParameterValue 检测
        }
        bool hasOpenY = GetParameterValue("ParamMouthOpenY", out _);
        bool hasForm = GetParameterValue("ParamMouthForm", out _);
        return (hasOpenY, hasForm, 0, 1, -1, 1);
    }

    /// <summary>
    /// 设置说话嘴型覆盖通道（独立通道，Native 在动作/表情/Idle/LipSync 合成与物理之后、
    /// model->Update 之前以最终值写入）。旧 Native 无该导出时返回 false（口型禁用，不影响气泡）。
    /// </summary>
    public bool SetMouthOverride(bool enabled, double openY, double form)
    {
        if (_handle == IntPtr.Zero)
            return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetMouthOverride(_handle, enabled ? 1 : 0, openY, form)
                   == Live2DInterop.OK;
        }
        catch (EntryPointNotFoundException)
        {
            return false;
        }
        catch (DllNotFoundException)
        {
            return false;
        }
    }

    /// <summary>人物互动：头部/身体临时附加偏移（角度）。全部 0 复位。</summary>
    public bool SetInteractionOffsets(double angleX, double angleY, double angleZ, double bodyAngleX)
    {
        if (_handle == IntPtr.Zero)
            return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetInteractionOffsets(_handle, angleX, angleY, angleZ, bodyAngleX)
                   == Live2DInterop.OK;
        }
        catch (EntryPointNotFoundException) { return false; }
        catch (DllNotFoundException) { return false; }
    }

    /// <summary>抚摸闭眼覆盖：enabled=1 时写入 ParamEyeLOpen/R（自动眨眼暂停）。</summary>
    public bool SetEyeOverride(bool enabled, double leftOpen, double rightOpen)
    {
        if (_handle == IntPtr.Zero)
            return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetEyeOverride(_handle, enabled ? 1 : 0, leftOpen, rightOpen)
                   == Live2DInterop.OK;
        }
        catch (EntryPointNotFoundException) { return false; }
        catch (DllNotFoundException) { return false; }
    }

    /// <summary>猫耳互动附加偏移（归一化 -1..1）。</summary>
    public bool SetEarInteraction(bool enabled, double left, double right)
    {
        if (_handle == IntPtr.Zero)
            return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetEarInteraction(_handle, enabled ? 1 : 0, left, right)
                   == Live2DInterop.OK;
        }
        catch (EntryPointNotFoundException) { return false; }
        catch (DllNotFoundException) { return false; }
    }

    /// <summary>抚摸期间降低 LookAt 对头部/身体角度权重（避免抵消抚摸转动）。</summary>
    public bool SetPettingLookAtReduction(bool enabled)
    {
        if (_handle == IntPtr.Zero)
            return false;
        try
        {
            return Live2DInterop.AliyaLive2D_SetPettingLookAtReduction(_handle, enabled ? 1 : 0)
                   == Live2DInterop.OK;
        }
        catch (EntryPointNotFoundException) { return false; }
        catch (DllNotFoundException) { return false; }
    }

    /// <summary>读取人物互动参数真实范围与猫耳根部参数信息。</summary>
    public (bool hasAngleX, bool hasAngleY, bool hasAngleZ, bool hasBodyX,
            double angleXMin, double angleXMax, double angleYMin, double angleYMax,
            double angleZMin, double angleZMax, double bodyXMin, double bodyXMax,
            bool hasEyeL, bool hasEyeR, double eyeLMin, double eyeLMax, double eyeRMin, double eyeRMax,
            bool hasLeftEarRoot, bool hasRightEarRoot, double leftEarRootMin, double leftEarRootMax,
            double rightEarRootMin, double rightEarRootMax, bool earRootPhysics) GetInteractionParamInfo()
    {
        var empty = (false, false, false, false,
            0d, 0d, 0d, 0d, 0d, 0d, 0d, 0d,
            false, false, 0d, 1d, 0d, 1d,
            false, false, -45d, 45d, -45d, 45d, false);
        if (_handle == IntPtr.Zero)
            return empty;
        try
        {
            if (Live2DInterop.AliyaLive2D_GetInteractionParamInfo(_handle, out var info) == Live2DInterop.OK)
                return (info.HasAngleX != 0, info.HasAngleY != 0, info.HasAngleZ != 0, info.HasBodyAngleX != 0,
                    info.AngleXMin, info.AngleXMax, info.AngleYMin, info.AngleYMax,
                    info.AngleZMin, info.AngleZMax, info.BodyXMin, info.BodyXMax,
                    info.HasEyeL != 0, info.HasEyeR != 0, info.EyeLMin, info.EyeLMax, info.EyeRMin, info.EyeRMax,
                    info.HasLeftEarRoot != 0, info.HasRightEarRoot != 0,
                    info.LeftEarRootMin, info.LeftEarRootMax, info.RightEarRootMin, info.RightEarRootMax,
                    info.EarRootPhysics != 0);
        }
        catch { }
        return empty;
    }

    /// <summary>列出检测到的猫耳参数（JSON 数组），供诊断日志。</summary>
    public string ListEarParams()
    {
        if (_handle == IntPtr.Zero)
            return "[]";
        var sb = new StringBuilder(4096);
        try
        {
            if (Live2DInterop.AliyaLive2D_ListEarParams(_handle, sb, sb.Capacity) == Live2DInterop.OK)
                return sb.ToString();
        }
        catch { }
        return "[]";
    }

    public void SetGazeIdleTimeout(double seconds)
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_SetMouseIdleTimeout(_handle, (float)Math.Clamp(seconds, 0.1, 30.0));
    }

    // ---- 运行时可设置项统一应用 + 回读诊断 ----

    /// <summary>一次性应用全部运行时设置（物理强度 / 输出幅度 / 静止待机时间 / 视线开关 / 视线速度）。
    /// 调用后立即通过 Getter 回读 Native 实际生效值，并写诊断日志，防止"UI 设置未进入 Native"。</summary>
    public void ApplyLive2DRuntimeSettings(double physicsStrength, double idleTimeoutSeconds, double outputAmplitude)
    {
        SetPhysicsStrength(physicsStrength);
        SetPhysicsOutputAmplitude(outputAmplitude);
        SetGazeIdleTimeout(idleTimeoutSeconds);
        LogRuntimeSettingsReadback();
    }

    /// <summary>回读当前生效设置并记录诊断日志。</summary>
    public void LogRuntimeSettingsReadback()
    {
        if (_handle == IntPtr.Zero || !_attached)
        {
            AppLog.Warn("LIVE2D_SETTINGS_READBACK not_ready");
            return;
        }
        try
        {
            int rc1 = Live2DInterop.AliyaLive2D_GetPhysicsStrength(_handle, out float current, out float target);
            int rc2 = Live2DInterop.AliyaLive2D_GetMouseIdleTimeout(_handle, out float timeout);
            int rc3 = Live2DInterop.AliyaLive2D_GetMouseIdleElapsed(_handle, out float elapsed);
            int rc4 = Live2DInterop.AliyaLive2D_GetGazeActivityState(_handle, out int state);
            int rc5 = Live2DInterop.AliyaLive2D_GetPhysicsGains(_handle,
                out float headCur, out float headTgt, out float bodyCur, out float bodyTgt,
                out float outCur, out float outTgt);
            AppLog.Info("LIVE2D_SETTINGS_READBACK physics_current={0:0.##} physics_target={1:0.##} "
                + "headGain={2:0.##}/{3:0.##} bodyGain={4:0.##}/{5:0.##} outputGain={6:0.##}/{7:0.##} "
                + "idleTimeout={8:0.##} idleElapsed={9:0.##} gazeState={10} rc={11}/{12}/{13}/{14}/{15}",
                current, target, headCur, headTgt, bodyCur, bodyTgt, outCur, outTgt,
                timeout, elapsed, state, rc1, rc2, rc3, rc4, rc5);

            // 物理驱动诊断：可见姿态输入 vs 物理虚拟输入（同帧回读）
            int rc6 = Live2DInterop.AliyaLive2D_GetPhysicsDriveInfo(_handle, out var di);
            float ratioX = Math.Abs(di.VisibleAngleX) > 1e-3f ? di.PhysicsAngleX / di.VisibleAngleX : 0.0f;
            float ratioZ = Math.Abs(di.VisibleAngleZ) > 1e-3f ? di.PhysicsAngleZ / di.VisibleAngleZ : 0.0f;
            AppLog.Info("LIVE2D_SETTINGS_READBACK visible={0:F2}/{1:F2}/{2:F2}/{3:F2} virtual={4:F2}/{5:F2}/{6:F2}/{7:F2} "
                + "ratioX={8:F2} ratioZ={9:F2} evalCount={10} rc6={11}",
                di.VisibleAngleX, di.VisibleAngleZ, di.VisibleBodyX, di.VisibleBodyZ,
                di.PhysicsAngleX, di.PhysicsAngleZ, di.PhysicsBodyX, di.PhysicsBodyZ,
                ratioX, ratioZ, di.EvaluateCount, rc6);

            // 输出幅度诊断：当前/目标、最大原始/最终增量、Clamp 命中、唯一参数/应用计数
            int rcAmp = Live2DInterop.AliyaLive2D_GetPhysicsOutputAmplitude(_handle, out float ampCur, out float ampTgt);
            AppLog.Info("LIVE2D_SETTINGS_READBACK_AMPLITUDE amplitude={0} / tgt={1} "
                + "headInputGain={2:0.##}/{3:0.##} bodyInputGain={4:0.##}/{5:0.##} "
                + "outputGain={6:0.##} outputRawMaxDelta={7:0.000} outputFinalMaxDelta={8:0.000} "
                + "outputClampHits={9} uniqueOutputs={10} amplitudeApplyCount={11} rcAmp={12}",
                ampCur, ampTgt,
                di.HeadInputGain, di.HeadInputGain, di.BodyInputGain, di.BodyInputGain,
                di.OutputGain, di.OutputMaxDelta, di.OutputFinalMaxDelta,
                di.OutputClampHits, di.UniqueOutputCount, di.AmplitudeApplyCount, rcAmp);
        }
        catch (Exception ex)
        {
            AppLog.Warn("LIVE2D_SETTINGS_READBACK exception={0}", ex.Message);
        }
    }

    public void ForceBlink()
    {
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_ForceBlink(_handle);
    }

    /// <summary>获取已加载动作列表（JSON 数组文本）。</summary>
    public string ListActions()
    {
        if (_handle == IntPtr.Zero) return "[]";
        var sb = new StringBuilder(16384);
        if (Live2DInterop.AliyaLive2D_ListActions(_handle, sb, sb.Capacity) != Live2DInterop.OK)
            return "[]";
        return sb.ToString();
    }

    public bool IsActionPlaying()
    {
        if (_handle == IntPtr.Zero) return false;
        Live2DInterop.AliyaLive2D_GetActionInfo(_handle, out var info);
        return info.IsPlaying != 0;
    }

    public string? CurrentActionId()
    {
        if (_handle == IntPtr.Zero) return null;
        Live2DInterop.AliyaLive2D_GetActionInfo(_handle, out var info);
        return string.IsNullOrEmpty(info.CurrentActionId) ? null : info.CurrentActionId;
    }

    /// <summary>轮询动作事件（JSON 数组），并清空 Native 队列。</summary>
    public string PollActionEvents()
    {
        if (_handle == IntPtr.Zero) return "[]";
        var sb = new StringBuilder(8192);
        if (Live2DInterop.AliyaLive2D_PollActionEvents(_handle, sb, sb.Capacity) != Live2DInterop.OK)
            return "[]";
        return sb.ToString();
    }
    public void Pause()
    {
        _running = false;
        _renderTimer.Stop();
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_Pause(_handle);
    }

    public void Resume()
    {
        if (_disposed) return;
        _running = true;
        _lastFrameTime = DateTime.UtcNow;
        _renderTimer.Start();
        if (_handle != IntPtr.Zero)
            Live2DInterop.AliyaLive2D_Resume(_handle);
        if (_bitmap is not null)
            _hostImage.Source = _bitmap;
        _hostImage.Visibility = Visibility.Visible;
    }

    public void Hide()
    {
        _running = false;
        _renderTimer.Stop();
        _hostImage.Visibility = Visibility.Collapsed;
    }

    public void Show()
    {
        if (_disposed) return;
        Resume();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _running = false;
        _renderTimer.Stop();
        if (_handle != IntPtr.Zero)
        {
            try
            {
                Live2DInterop.AliyaLive2D_Destroy(_handle);
            }
            catch (Exception ex)
            {
                AppLog.Error("Live2D Dispose 异常: {0}", ex);
            }
            _handle = IntPtr.Zero;
        }
        if (_pixelBuffer != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(_pixelBuffer);
            _pixelBuffer = IntPtr.Zero;
        }
        _bitmap = null;
        _hostImage.Source = null;
        _hostImage.Visibility = Visibility.Collapsed;
        GC.SuppressFinalize(this);
    }

    private void EnsureNotDisposed()
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(Live2DCharacterRenderer));
    }
}



