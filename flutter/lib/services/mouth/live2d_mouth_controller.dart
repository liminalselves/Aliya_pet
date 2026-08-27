import '../../models/mouth/mouth_animation_frame.dart';
import '../../native/aliya_live2d_host.dart';
import 'mouth_controller.dart';

/// Live2D 嘴型控制器：启动时检测当前模型真实嘴部参数，不写死。
/// 优先 ParamMouthOpenY / ParamMouthForm；只存在 OpenY 时只驱动张嘴幅度；
/// 两个都不存在时不崩溃、跳过嘴型并记录一次警告。
class Live2DMouthController implements MouthController {
  Live2DMouthController(this._getHost);

  final AliyaLive2DHost? Function() _getHost;
  bool _detected = false;
  bool _available = false;
  bool _hasOpenY = false;
  bool _hasForm = false;
  double _openYMin = 0;
  double _openYMax = 1;
  double _formMin = -1;
  double _formMax = 1;
  bool _warningLogged = false;

  /// 模型重载（切换角色/重建渲染器）后重置检测缓存，下次使用重新检测。
  void resetDetection() {
    _detected = false;
    _available = false;
    _hasOpenY = false;
    _hasForm = false;
    _openYMin = 0;
    _openYMax = 1;
    _formMin = -1;
    _formMax = 1;
  }

  @override
  bool get isAvailable {
    _ensureDetected();
    return _available;
  }

  @override
  void write(MouthAnimationFrame frame) {
    _ensureDetected();
    final host = _getHost();
    if (host == null || !_available) return;

    final openY = _map(_openYMin, _openYMax, frame.openY);
    final form = _hasForm ? _map(_formMin, _formMax, frame.form) : 0.0;
    try {
      host.bindings.setMouthOverride(host.handle, true, openY, form);
    } catch (_) {
      // 写入失败不影响气泡
    }
  }

  @override
  void release() {
    final host = _getHost();
    if (host == null) return;
    try {
      host.bindings.setMouthOverride(host.handle, false, 0, 0);
    } catch (_) {
      // 忽略
    }
  }

  void _ensureDetected() {
    if (_detected) return;

    final host = _getHost();
    if (host == null) {
      // M10 修复：host 尚未就绪时不置 _detected，下次调用重试，
      // 避免初始化竞争导致嘴型整会话失效。
      _available = false;
      return;
    }

    _detected = true;

    try {
      final info = host.mouthParamInfo;
      _hasOpenY = info.hasOpenY != 0;
      _hasForm = info.hasForm != 0;
      _openYMin = info.openYMin;
      _openYMax = info.openYMax;
      _formMin = info.formMin;
      _formMax = info.formMax;

      if (_hasOpenY) {
        _available = true;
      } else if (!_warningLogged) {
        _warningLogged = true;
        // 模型无 ParamMouthOpenY/ParamMouthForm，跳过嘴型
      }
    } catch (_) {
      if (!_warningLogged) {
        _warningLogged = true;
        // 嘴部参数检测失败，跳过嘴型
      }
    }
  }

  static double _map(double min, double max, double normalized) {
    // M11 修复：校验 NaN 与倒序/退化范围，避免写出范围外值
    if (min.isNaN || max.isNaN || normalized.isNaN) return 0.0;
    if (min >= max) return min;
    final n = normalized.clamp(0.0, 1.0);
    final result = min + (max - min) * n;
    return result.clamp(min, max);
  }
}
