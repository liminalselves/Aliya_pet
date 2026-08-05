using System;
using System.Diagnostics;
using System.Windows.Threading;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Interaction;

/// <summary>
/// 抚摸/互动参数动画控制器：
///   - 头部互动偏移（ParamAngleX/Y/Z + ParamBodyAngleX）：按平滑速度阻尼跟随，结束后 300~650ms 回正
///   - 抚摸闭眼（ParamEyeLOpen/R）：180~320ms 闭合、280~500ms 缓慢睁眼，自动眨眼由 Native 暂停
///   - 猫耳附加偏移：比头部延迟 50~140ms，产生轻微惯性
/// 全部经 Native 互动通道写入（controller 与物理之后、mouth override 之前），不改变基础参数。
/// </summary>
public sealed class PettingReactionController
{
    private const int TickMs = 33;

    private readonly Func<Live2DCharacterRenderer?> _getRenderer;
    private readonly DispatcherTimer _timer;
    private readonly object _gate = new();
    private readonly Random _random = new();

    private bool _configured;
    private bool _available;
    private bool _hasEyes;
    private bool _hasEars;
    private bool _warningLogged;

    // 头部真实范围
    private double _angleXMin = -30, _angleXMax = 30;
    private double _angleYMin = -30, _angleYMax = 30;
    private double _angleZMin = -30, _angleZMax = 30;
    private double _bodyXMin = -30, _bodyXMax = 30;

    // 眼睛真实范围
    private double _eyeLMin = 0, _eyeLMax = 1, _eyeRMin = 0, _eyeRMax = 1;

    // 猫耳根部互动状态（只操作根部参数）
    private bool _earRootPhysics;
    private string _earRootLeftId = "";
    private string _earRootRightId = "";
    private bool _earRootDebugEnabled;
    private long _earRootDebugLastMs;

    // 当前平滑值
    private double _curAngleX, _curAngleY, _curAngleZ, _curBodyX;
    private double _curEarLeft, _curEarRight;

    // 目标值（由 SetVelocity 更新）
    private double _targetAngleX, _targetAngleY, _targetAngleZ;
    private double _targetEarLeft, _targetEarRight;

    // 眼睛
    private enum EyeState { Idle, Closing, Opening }
    private EyeState _eyeState;
    private double _eyeOpenness = 1.0; // 0=闭 1=睁（归一化）
    private bool _eyeOverrideActive;

    private long _lastTickMs;

    // 猫耳互动模式：当前正式版本完全禁用（模型缺少安全公共根部，Rotation_1 无法整体带动全部图层）。
    // 模型修复并验证后才允许改为 Enabled（见 EAR_ROOT_PARAMETER_UNSAFE 判定）。
    private const bool EarInteractionModeEnabled = false;

    // ---- 头部跟随参数（度）----
    // 标准强度：AngleX ±7 / AngleZ ±9 / 低头 -2.5；低强度 4.5/6/1.5；高强度 8.5/11/3。
    private const double MaxAngleX = 7.0;
    private const double MaxAngleZ = 9.0;
    private const double MaxAngleY = 2.5;
    // 方向映射统一符号：如模型实际方向相反，只改此常量，不在多处分别修正。
    private const double PettingDirectionSign = 1.0;
    // 速度归一化参考（px/s）：达到该速度即接近最大角度
    private const double VelocityReference = 300.0;
    // 有效抚摸最低反馈角度（避免低速时头部几乎不动）
    private const double MinAngleX = 2.2;
    private const double MinAngleZ = 2.8;
    // 鼠标短暂停止时的放松静止姿态（保留最后方向的一部分）
    private const double IdleHoldAngleX = 2.0;
    private const double IdleHoldAngleZ = 2.6;
    private const double IdleHoldAngleY = 1.5;

    private bool _pettingActive;
    private double _lastVel;
    private double _lastDir; // -1/0/1 最后水平方向
    private DateTime _lastInputUtc = DateTime.MinValue;

    // 平滑：头部响应 90~130ms；松手回正 350~600ms（用更慢 tau 实现）
    private static readonly double HeadTauSeconds = 0.10;
    private static readonly double ReturnTauSeconds = 0.16;

    public PettingReactionController(Func<Live2DCharacterRenderer?> getRenderer)
    {
        _getRenderer = getRenderer;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(TickMs) };
        _timer.Tick += (_, _) => Tick();
    }

    /// <summary>是否可用（Live2D 就绪）。PNG 模式下互动参数静默跳过。</summary>
    public bool IsAvailable => _available;

    public void Start() => _timer.Start();

    public void Stop() => _timer.Stop();

    /// <summary>按平滑水平速度设置头部目标（velocity 为物理像素/秒；petting=false 时全部回正）。
    /// 猫耳互动已禁用：不写任何猫耳参数，耳朵由原 Physics 随头部自然摆动。</summary>
    public void SetVelocity(double velXPxPerSec, bool petting)
    {
        lock (_gate)
        {
            _lastInputUtc = DateTime.UtcNow;
            if (!petting)
            {
                _pettingActive = false;
                _lastVel = 0;
                _lastDir = 0;
                _targetAngleX = 0;
                _targetAngleY = 0;
                _targetAngleZ = 0;
                ApplyLookAtReduction(false);
                return;
            }
            _pettingActive = true;
            _lastVel = Math.Clamp(velXPxPerSec, -800, 800);
            if (Math.Abs(_lastVel) > 20)
                _lastDir = Math.Sign(_lastVel);
            ApplyLookAtReduction(true);
            ComputePettingTargets(_lastVel);
        }
    }

    /// <summary>非线性响应：低速也有明显反馈，高速仍受上限限制。</summary>
    private void ComputePettingTargets(double vel)
    {
        double normalized = Math.Clamp(vel / VelocityReference, -1, 1);
        double response = Math.Sign(normalized) * Math.Pow(Math.Abs(normalized), 0.65);
        double angleX = response * MaxAngleX * PettingDirectionSign;
        double angleZ = -response * MaxAngleZ * PettingDirectionSign; // 手掌右 → 头右倾（负号并入此映射）

        // 有效抚摸最低反馈
        if (Math.Abs(normalized) > 0.02)
        {
            int xSign = angleX >= 0 ? 1 : -1;
            int zSign = angleZ >= 0 ? 1 : -1;
            if (Math.Abs(angleX) < MinAngleX) angleX = MinAngleX * xSign;
            if (Math.Abs(angleZ) < MinAngleZ) angleZ = MinAngleZ * zSign;
        }

        _targetAngleX = angleX;
        _targetAngleZ = angleZ;
        _targetAngleY = -MaxAngleY; // 轻微低头
    }

    /// <summary>关闭眼睛（抚摸开始）：180~320ms 平滑闭合。配置未完成时也设置状态，配置后生效。</summary>
    public void BeginEyeClose()
    {
        lock (_gate)
        {
            _eyeState = EyeState.Closing;
            _eyeOverrideActive = true;
        }
    }

    /// <summary>睁眼（抚摸结束）：280~500ms 缓慢睁开，完成后恢复自动眨眼。</summary>
    public void BeginEyeOpen()
    {
        lock (_gate)
        {
            _eyeState = EyeState.Opening;
            _eyeOverrideActive = true;
        }
    }

    /// <summary>立即复位全部互动参数（退出抚摸/异常恢复）。</summary>
    public void ResetAll()
    {
        lock (_gate)
        {
            _curAngleX = _curAngleY = _curAngleZ = _curBodyX = 0;
            _curEarLeft = _curEarRight = 0;
            _targetEarLeft = _targetEarRight = 0;
            _eyeState = EyeState.Idle;
            _eyeOpenness = 1.0;
            _eyeOverrideActive = false;
            _pettingActive = false;
            _lastDir = 0;
            ApplyLookAtReduction(false);
        }
        WriteAll(force: true);
    }

    /// <summary>抚摸期间降低 LookAt 对头部角度权重，避免 LookAt 抵消抚摸转动（Native 侧生效）。</summary>
    private void ApplyLookAtReduction(bool enabled)
    {
        var renderer = _getRenderer();
        if (renderer is null)
            return;
        try
        {
            renderer.SetPettingLookAtReduction(enabled);
        }
        catch
        {
            // 忽略：旧 Native 无此接口时 LookAt 权重保持默认
        }
    }

    private void Tick()
    {
        var renderer = _getRenderer();
        if (renderer is null)
            return;
        EnsureConfigured(renderer);
        if (!_available)
            return;

        long nowMs = Environment.TickCount64;
        double dt = Math.Clamp((nowMs - _lastTickMs) / 1000.0, 0.001, 0.1);
        _lastTickMs = nowMs;

        lock (_gate)
        {
            UpdateEye(dt);

            // 目标选择：运动中 → 运动目标；短暂停止（<0.45s）→ 放松静止姿态；长时间停止 → 回中
            double idleSec = (DateTime.UtcNow - _lastInputUtc).TotalSeconds;
            if (_pettingActive)
            {
                if (idleSec < 0.08)
                {
                    ComputePettingTargets(_lastVel);
                }
                else if (idleSec < 0.45)
                {
                    // 静止姿态：保留最后方向 25~35% + 轻微低头
                    _targetAngleX = _lastDir * IdleHoldAngleX * PettingDirectionSign;
                    _targetAngleZ = -_lastDir * IdleHoldAngleZ * PettingDirectionSign;
                    _targetAngleY = -IdleHoldAngleY;
                }
                else
                {
                    _targetAngleX = 0;
                    _targetAngleZ = 0;
                    _targetAngleY = 0;
                }
            }

            // 头部一阶滞后：运动响应 90~130ms，回正（非抚摸）350~600ms
            double tau = _pettingActive ? HeadTauSeconds : ReturnTauSeconds;
            double k = 1.0 - Math.Exp(-dt / tau);
            _curAngleX += (ClampHead(_angleXMin, _angleXMax, _targetAngleX) - _curAngleX) * k;
            _curAngleY += (ClampHead(_angleYMin, _angleYMax, _targetAngleY) - _curAngleY) * k;
            _curAngleZ += (ClampHead(_angleZMin, _angleZMax, _targetAngleZ) - _curAngleZ) * k;
            _curBodyX += (ClampHead(_bodyXMin, _bodyXMax, 0) - _curBodyX) * k;

            double earK = 1.0 - Math.Exp(-dt / 0.16);
            _curEarLeft += (_targetEarLeft - _curEarLeft) * earK;
            _curEarRight += (_targetEarRight - _curEarRight) * earK;
        }
        WriteAll(force: false);

        if (_earRootDebugEnabled && _hasEars && nowMs - _earRootDebugLastMs >= 200)
        {
            _earRootDebugLastMs = nowMs;
            LogEarRootDebug(renderer);
        }
    }

    private void LogEarRootDebug(Live2DCharacterRenderer renderer)
    {
        int gestureDirection = Math.Sign(_targetEarRight);
        renderer.GetParameterValue(_earRootLeftId, out double leftFinal);
        renderer.GetParameterValue(_earRootRightId, out double rightFinal);
        double leftPhysicsBase = leftFinal - _curEarLeft * 2.0;   // final = physicsBase + current*2.0
        double rightPhysicsBase = rightFinal - _curEarRight * 2.0;
        AppLog.Info("EAR_ROOT_DEBUG leftRoot={0} rightRoot={1} gestureDir={2} targetL={3:0.00} targetR={4:0.00} currentL={5:0.00} currentR={6:0.00} physicsBaseL={7:0.##} physicsBaseR={8:0.##} finalL={9:0.##} finalR={10:0.##}",
            _earRootLeftId, _earRootRightId, gestureDirection,
            _targetEarLeft, _targetEarRight, _curEarLeft, _curEarRight,
            leftPhysicsBase, rightPhysicsBase, leftFinal, rightFinal);
    }

    private void UpdateEye(double dt)
    {
        switch (_eyeState)
        {
            case EyeState.Closing:
            {
                double k = 1.0 - Math.Exp(-dt / 0.25);
                _eyeOpenness += (0 - _eyeOpenness) * k;
                if (_eyeOpenness < 0.02)
                {
                    _eyeOpenness = 0;
                    _eyeState = EyeState.Idle; // 维持闭合
                }
                break;
            }
            case EyeState.Opening:
            {
                double k = 1.0 - Math.Exp(-dt / 0.38);
                _eyeOpenness += (1 - _eyeOpenness) * k;
                if (_eyeOpenness > 0.98)
                {
                    _eyeOpenness = 1;
                    _eyeState = EyeState.Idle;
                    _eyeOverrideActive = false; // 恢复自动眨眼
                }
                break;
            }
        }
    }

    private void WriteAll(bool force)
    {
        var renderer = _getRenderer();
        if (renderer is null)
            return;
        try
        {
            renderer.SetInteractionOffsets(_curAngleX, _curAngleY, _curAngleZ, _curBodyX);
            if (_eyeOverrideActive && _hasEyes)
            {
                double l = _eyeLMin + _eyeOpenness * (_eyeLMax - _eyeLMin);
                double r = _eyeRMin + _eyeOpenness * (_eyeRMax - _eyeRMin);
                renderer.SetEyeOverride(true, l, r);
            }
            else
            {
                renderer.SetEyeOverride(false, 0, 0);
            }
            // 猫耳互动已禁用（EarInteractionMode=Disabled）：始终清零耳朵互动偏移，
            // 不得写入任何 Param_Angle_Rotation_*_CAT_Ear_* 参数，耳朵由原 Physics 自然摆动。
            renderer.SetEarInteraction(false, 0, 0);
        }
        catch
        {
            // Native 写入失败不影响互动流程
        }
    }

    /// <summary>模型重载（切换角色/重建渲染器）后重置配置缓存，下次自动重新检测。</summary>
    public void ResetConfiguration()
    {
        lock (_gate)
        {
            _configured = false;
            _available = false;
            _hasEyes = false;
            _hasEars = false;
            _warningLogged = false;
        }
    }

    /// <summary>开启猫耳根部调试（--ear-root-debug，每 200ms 记录一次）。</summary>
    public bool EarRootDebugEnabled
    {
        get => _earRootDebugEnabled;
        set
        {
            _earRootDebugEnabled = value;
            _earRootDebugLastMs = 0;
        }
    }

    private void EnsureConfigured(Live2DCharacterRenderer renderer)
    {
        if (_configured)
            return;
        _configured = true;
        try
        {
            var info = renderer.GetInteractionParamInfo();
            _angleXMin = info.angleXMin; _angleXMax = info.angleXMax;
            _angleYMin = info.angleYMin; _angleYMax = info.angleYMax;
            _angleZMin = info.angleZMin; _angleZMax = info.angleZMax;
            _bodyXMin = info.bodyXMin; _bodyXMax = info.bodyXMax;
            _eyeLMin = info.eyeLMin; _eyeLMax = info.eyeLMax;
            _eyeRMin = info.eyeRMin; _eyeRMax = info.eyeRMax;
            _hasEyes = info.hasEyeL && info.hasEyeR;
            _hasEars = info.hasLeftEarRoot || info.hasRightEarRoot;
            _earRootPhysics = info.earRootPhysics;
            _earRootLeftId = _earRootRightId = "";
            _available = true;

            AppLog.Info("INTERACTION_PARAMS_DETECTED headX={0}~{1} headY={2}~{3} headZ={4}~{5} eyeL={6}~{7} eyeR={8}~{9} earRoot(L/R)={10}/{11} earRootPhysics={12}",
                _angleXMin, _angleXMax, _angleYMin, _angleYMax, _angleZMin, _angleZMax,
                _eyeLMin, _eyeLMax, _eyeRMin, _eyeRMax,
                info.hasLeftEarRoot ? 1 : 0, info.hasRightEarRoot ? 1 : 0,
                info.earRootPhysics ? 1 : 0);

            string earJson = renderer.ListEarParams();
            if (earJson.Length > 2)
            {
                AppLog.Info("INTERACTION_EAR_PARAMS {0}", earJson);
                // 从 JSON 提取左右根部参数 ID（供 --ear-root-debug 与报告）
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(earJson);
                    foreach (var e in doc.RootElement.EnumerateArray())
                    {
                        string side = e.TryGetProperty("side", out var s) ? s.GetString() ?? "" : "";
                        string id = e.TryGetProperty("id", out var i) ? i.GetString() ?? "" : "";
                        if (side == "left") _earRootLeftId = id;
                        else if (side == "right") _earRootRightId = id;
                    }
                }
                catch { }
            }
            AppLog.Info("EAR_ROOT_PARAMETER left={0} right={1} range_left={2}~{3} range_right={4}~{5} physicsControlled={6}",
                _earRootLeftId, _earRootRightId,
                info.leftEarRootMin, info.leftEarRootMax, info.rightEarRootMin, info.rightEarRootMax,
                info.earRootPhysics ? 1 : 0);

            if (!_hasEyes && !_warningLogged)
            {
                _warningLogged = true;
                AppLog.Warn("INTERACTION_EYE_MISSING 模型无 ParamEyeLOpen/ParamEyeROpen，抚摸时不闭眼，继续执行头部与台词");
            }
        }
        catch (Exception ex)
        {
            if (!_warningLogged)
            {
                _warningLogged = true;
                AppLog.Warn("INTERACTION_PARAMS_DETECT_FAILED error={0}", ex.Message);
            }
        }
    }

    private static double ClampHead(double min, double max, double v)
    {
        if (min >= max)
            return v;
        return Math.Clamp(v, min, max);
    }
}
