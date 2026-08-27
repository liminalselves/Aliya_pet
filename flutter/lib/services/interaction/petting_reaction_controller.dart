import 'dart:async';
import 'dart:math' as math;

import '../../native/aliya_live2d_bindings.dart';

/// 眼睛动画状态。
enum _EyeState { idle, closing, opening }

/// 互动目标（Live2D 渲染器抽象，PNG 模式可提供空实现）。
abstract class InteractionTarget {
  AliyaInteractionParamInfoData get interactionParamInfo;

  String listEarParams();

  void setInteractionOffsets(double angleX, double angleY, double angleZ, double bodyAngleX);

  void setEyeOverride(bool enabled, double leftOpen, double rightOpen);

  void setEarInteraction(bool enabled, double leftValue, double rightValue);

  void setPettingLookAtReduction(bool enabled);

  /// 脸红（ParamCheek 0..1）。enabled=false 时清零。
  void setFaceCheek(bool enabled, double value);
}

/// 抚摸/互动参数动画控制器：
///   - 头部互动偏移（ParamAngleX/Y/Z + ParamBodyAngleX）：按平滑速度阻尼跟随，结束后 300~650ms 回正
///   - 抚摸闭眼（ParamEyeLOpen/R）：180~320ms 闭合、280~500ms 缓慢睁眼，自动眨眼由 Native 暂停
///   - 猫耳附加偏移：比头部延迟 50~140ms，产生轻微惯性
/// 全部经 Native 互动通道写入（controller 与物理之后、mouth override 之前），不改变基础参数。
class PettingReactionController {
  PettingReactionController(this._getTarget) {
    // 不预创建 timer，由 start() 统一创建
  }

  static const int _tickMs = 33;

  final InteractionTarget? Function() _getTarget;
  Timer? _timer;

  bool _configured = false;
  bool _available = false;
  bool _hasEyes = false;
  bool _warningLogged = false;

  // 头部真实范围
  double _angleXMin = -30, _angleXMax = 30;
  double _angleYMin = -30, _angleYMax = 30;
  double _angleZMin = -30, _angleZMax = 30;
  double _bodyXMin = -30, _bodyXMax = 30;

  // 眼睛真实范围
  double _eyeLMin = 0, _eyeLMax = 1, _eyeRMin = 0, _eyeRMax = 1;

  // 当前平滑值
  double _curAngleX = 0, _curAngleY = 0, _curAngleZ = 0, _curBodyX = 0;
  double _curEarLeft = 0, _curEarRight = 0;

  // 目标值（由 setVelocity 更新）
  double _targetAngleX = 0, _targetAngleY = 0, _targetAngleZ = 0;
  double _targetEarLeft = 0, _targetEarRight = 0;

  // 眼睛
  _EyeState _eyeState = _EyeState.idle;
  double _eyeOpenness = 1.0; // 0=闭 1=睁（归一化）
  bool _eyeOverrideActive = false;

  int _lastTickMs = 0;

  // ---- 头部跟随参数（度）----
  static const double _maxAngleX = 7.0;
  static const double _maxAngleZ = 9.0;
  static const double _maxAngleY = 2.5;
  static const double _pettingDirectionSign = 1.0;
  static const double _velocityReference = 300.0;
  static const double _minAngleX = 2.2;
  static const double _minAngleZ = 2.8;
  static const double _idleHoldAngleX = 2.0;
  static const double _idleHoldAngleZ = 2.6;
  static const double _idleHoldAngleY = 1.5;

  bool _pettingActive = false;
  double _lastVel = 0;
  double _lastDir = 0;
  DateTime _lastInputUtc = DateTime.fromMillisecondsSinceEpoch(0);

  // 平滑
  static const double _headTauSeconds = 0.10;
  static const double _returnTauSeconds = 0.16;

  // ---- Native 写入合并 ----
  static const double _angleEpsilonDeg = 0.05;
  static const double _eyeEpsilon = 0.005;
  static const int _nativeForceRefreshMs = 250;
  double _lastCommitAngleX = 0, _lastCommitAngleY = 0, _lastCommitAngleZ = 0, _lastCommitBodyX = 0;
  bool _lastCommitEyeEnabled = false;
  double _lastCommitEyeL = 0, _lastCommitEyeR = 0;
  bool _earCommitWritten = false;
  bool _lastLookAtReduction = false;
  int _lastNativeCommitTick = 0;

  /// 是否可用（Live2D 就绪）。PNG 模式下互动参数静默跳过。
  bool get isAvailable => _available;

  void start() {
    if (_timer != null && _timer!.isActive) return;
    _lastTickMs = DateTime.now().millisecondsSinceEpoch;
    _timer = Timer.periodic(
        const Duration(milliseconds: _tickMs), (_) => _tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 按平滑水平速度设置头部目标（velocity 为物理像素/秒；petting=false 时全部回正）。
  void setVelocity(double velXPxPerSec, {required bool petting}) {
    _lastInputUtc = DateTime.now().toUtc();
    if (!petting) {
      _pettingActive = false;
      _lastVel = 0;
      _lastDir = 0;
      _targetAngleX = 0;
      _targetAngleY = 0;
      _targetAngleZ = 0;
      _applyLookAtReduction(false);
      return;
    }
    _pettingActive = true;
    _lastVel = velXPxPerSec.clamp(-800.0, 800.0);
    if (_lastVel.abs() > 20) {
      _lastDir = _lastVel.sign;
    }
    _applyLookAtReduction(true);
    _computePettingTargets(_lastVel);
  }

  /// 非线性响应：低速也有明显反馈，高速仍受上限限制。
  void _computePettingTargets(double vel) {
    final normalized =
        (vel / _velocityReference).clamp(-1.0, 1.0).toDouble();
    final response = normalized.sign *
        math.pow(normalized.abs(), 0.65).toDouble();
    var angleX = response * _maxAngleX * _pettingDirectionSign;
    var angleZ = -response * _maxAngleZ * _pettingDirectionSign; // 手掌右 → 头右倾

    // 有效抚摸最低反馈
    if (normalized.abs() > 0.02) {
      final xSign = angleX >= 0 ? 1 : -1;
      final zSign = angleZ >= 0 ? 1 : -1;
      if (angleX.abs() < _minAngleX) angleX = _minAngleX * xSign;
      if (angleZ.abs() < _minAngleZ) angleZ = _minAngleZ * zSign;
    }

    _targetAngleX = angleX;
    _targetAngleZ = angleZ;
    _targetAngleY = -_maxAngleY; // 轻微低头
  }

  /// 关闭眼睛（抚摸开始）：180~320ms 平滑闭合。
  void beginEyeClose() {
    _eyeState = _EyeState.closing;
    _eyeOverrideActive = true;
  }

  /// 睁眼（抚摸结束）：280~500ms 缓慢睁开，完成后恢复自动眨眼。
  void beginEyeOpen() {
    _eyeState = _EyeState.opening;
    _eyeOverrideActive = true;
  }

  /// 立即复位全部互动参数（退出抚摸/异常恢复）。
  void resetAll() {
    _curAngleX = _curAngleY = _curAngleZ = _curBodyX = 0;
    _curEarLeft = _curEarRight = 0;
    _targetEarLeft = _targetEarRight = 0;
    _eyeState = _EyeState.idle;
    _eyeOpenness = 1.0;
    _eyeOverrideActive = false;
    _pettingActive = false;
    _lastDir = 0;
    _applyLookAtReduction(false, force: true);
    _writeAll(force: true);
  }

  /// 抚摸期间降低 LookAt 对头部角度权重（Native 侧生效）。
  void _applyLookAtReduction(bool enabled, {bool force = false}) {
    if (!force && _lastLookAtReduction == enabled) return;
    _lastLookAtReduction = enabled;
    final target = _getTarget();
    if (target == null) return;
    try {
      target.setPettingLookAtReduction(enabled);
    } catch (_) {
      // 忽略：旧 Native 无此接口时 LookAt 权重保持默认
    }
  }

  void _tick() {
    final target = _getTarget();
    if (target == null) return;
    _ensureConfigured(target);
    if (!_available) return;

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final dt = ((nowMs - _lastTickMs) / 1000.0).clamp(0.001, 0.1);
    _lastTickMs = nowMs;

    _updateEye(dt);

    // 目标选择：运动中 → 运动目标；短暂停止（<0.45s）→ 放松静止姿态；长时间停止 → 回中
    final idleSec = DateTime.now().toUtc().difference(_lastInputUtc).inMicroseconds / 1e6;
    if (_pettingActive) {
      if (idleSec < 0.08) {
        _computePettingTargets(_lastVel);
      } else if (idleSec < 0.45) {
        // 静止姿态：保留最后方向 25~35% + 轻微低头
        _targetAngleX = _lastDir * _idleHoldAngleX * _pettingDirectionSign;
        _targetAngleZ = -_lastDir * _idleHoldAngleZ * _pettingDirectionSign;
        _targetAngleY = -_idleHoldAngleY;
      } else {
        _targetAngleX = 0;
        _targetAngleZ = 0;
        _targetAngleY = 0;
      }
    }

    // 头部一阶滞后：运动响应 90~130ms，回正 350~600ms
    final tau = _pettingActive ? _headTauSeconds : _returnTauSeconds;
    final k = 1.0 - math.exp(-dt / tau);
    _curAngleX += (_clampHead(_angleXMin, _angleXMax, _targetAngleX) - _curAngleX) * k;
    _curAngleY += (_clampHead(_angleYMin, _angleYMax, _targetAngleY) - _curAngleY) * k;
    _curAngleZ += (_clampHead(_angleZMin, _angleZMax, _targetAngleZ) - _curAngleZ) * k;
    _curBodyX += (_clampHead(_bodyXMin, _bodyXMax, 0) - _curBodyX) * k;

    final earK = 1.0 - math.exp(-dt / 0.16);
    _curEarLeft += (_targetEarLeft - _curEarLeft) * earK;
    _curEarRight += (_targetEarRight - _curEarRight) * earK;

    _writeAll(force: false);
  }

  void _updateEye(double dt) {
    switch (_eyeState) {
      case _EyeState.closing:
        final k = 1.0 - math.exp(-dt / 0.25);
        _eyeOpenness += (0 - _eyeOpenness) * k;
        if (_eyeOpenness < 0.02) {
          _eyeOpenness = 0;
          _eyeState = _EyeState.idle; // 维持闭合
        }
        break;
      case _EyeState.opening:
        final k = 1.0 - math.exp(-dt / 0.38);
        _eyeOpenness += (1 - _eyeOpenness) * k;
        if (_eyeOpenness > 0.98) {
          _eyeOpenness = 1;
          _eyeState = _EyeState.idle;
          _eyeOverrideActive = false; // 恢复自动眨眼
        }
        break;
      case _EyeState.idle:
        break;
    }
  }

  void _writeAll({bool force = false}) {
    final target = _getTarget();
    if (target == null) return;
    try {
      final eyeEnabled = _eyeOverrideActive && _hasEyes;
      final eyeL = eyeEnabled
          ? _eyeLMin + _eyeOpenness * (_eyeLMax - _eyeLMin)
          : 0.0;
      final eyeR = eyeEnabled
          ? _eyeRMin + _eyeOpenness * (_eyeRMax - _eyeRMin)
          : 0.0;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final forceRefresh = force || nowMs - _lastNativeCommitTick >= _nativeForceRefreshMs;

      // 头部互动偏移
      if (forceRefresh ||
          (_curAngleX - _lastCommitAngleX).abs() > _angleEpsilonDeg ||
          (_curAngleY - _lastCommitAngleY).abs() > _angleEpsilonDeg ||
          (_curAngleZ - _lastCommitAngleZ).abs() > _angleEpsilonDeg ||
          (_curBodyX - _lastCommitBodyX).abs() > _angleEpsilonDeg) {
        target.setInteractionOffsets(_curAngleX, _curAngleY, _curAngleZ, _curBodyX);
        _lastCommitAngleX = _curAngleX;
        _lastCommitAngleY = _curAngleY;
        _lastCommitAngleZ = _curAngleZ;
        _lastCommitBodyX = _curBodyX;
      }

      // 眼睛覆盖
      if (forceRefresh ||
          eyeEnabled != _lastCommitEyeEnabled ||
          (eyeL - _lastCommitEyeL).abs() > _eyeEpsilon ||
          (eyeR - _lastCommitEyeR).abs() > _eyeEpsilon) {
        target.setEyeOverride(eyeEnabled, eyeL, eyeR);
        _lastCommitEyeEnabled = eyeEnabled;
        _lastCommitEyeL = eyeL;
        _lastCommitEyeR = eyeR;
      }

      // 猫耳互动已禁用：只在首次/强制刷新时写入一次关闭状态
      if (!_earCommitWritten || forceRefresh) {
        target.setEarInteraction(false, 0, 0);
        _earCommitWritten = true;
      }

      _lastNativeCommitTick = nowMs;
    } catch (_) {
      // Native 写入失败不影响互动流程
    }
  }

  /// 模型重载（切换角色/重建渲染器）后重置配置缓存，下次自动重新检测。
  void resetConfiguration() {
    _configured = false;
    _available = false;
    _hasEyes = false;
    _warningLogged = false;
    _lastCommitAngleX = double.nan;
    _lastCommitAngleY = double.nan;
    _lastCommitAngleZ = double.nan;
    _lastCommitBodyX = double.nan;
    _lastCommitEyeEnabled = false;
    _lastCommitEyeL = double.nan;
    _lastCommitEyeR = double.nan;
    _earCommitWritten = false;
    _lastLookAtReduction = false;
    _lastNativeCommitTick = 0;
  }

  void _ensureConfigured(InteractionTarget target) {
    if (_configured) return;
    _configured = true;
    try {
      final info = target.interactionParamInfo;
      _angleXMin = info.angleXMin;
      _angleXMax = info.angleXMax;
      _angleYMin = info.angleYMin;
      _angleYMax = info.angleYMax;
      _angleZMin = info.angleZMin;
      _angleZMax = info.angleZMax;
      _bodyXMin = info.bodyXMin;
      _bodyXMax = info.bodyXMax;
      _eyeLMin = info.eyeLMin;
      _eyeLMax = info.eyeLMax;
      _eyeRMin = info.eyeRMin;
      _eyeRMax = info.eyeRMax;
      _hasEyes = info.hasEyeL != 0 && info.hasEyeR != 0;
      _available = true;
    } catch (_) {
      if (!_warningLogged) {
        _warningLogged = true;
        // 互动参数检测失败
      }
    }
  }

  static double _clampHead(double min, double max, double v) {
    if (min >= max) return v;
    return v.clamp(min, max).toDouble();
  }
}
