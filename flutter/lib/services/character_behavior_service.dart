import 'dart:async';
import 'dart:math' as math;

import '../native/aliya_live2d_host.dart';

/// 视线跟随模式。
enum GazeFollowMode {
  /// 人物附近跟随：光标离开角色区域（外扩缓冲）→ 清除目标，人物缓慢回正。
  nearby,

  /// 全程跟随。
  always,
}

/// 角色行为服务：随机动作调度、动作播放、视线跟随。
///
/// 对应原 WPF 版 MainWindow 的行为控制（随机动作/自动动作/视线跟随），
/// 与渲染框架解耦，输入由上层（Widget 手势层）提供。
///
/// **生命周期管理**：
/// 本服务内部持有 [Timer] 实例用于自动动作和随机台词调度。
/// 使用完毕后必须调用 [dispose()] 方法取消所有 Timer，否则会导致：
/// - Timer 持续运行，即使宿主 Widget 已销毁
/// - 内存泄漏（Timer 持有闭包引用）
/// - 可能的空指针异常（Timer 回调访问已释放的资源）
///
/// 推荐在宿主 State 的 dispose() 中调用本服务的 dispose()。
class CharacterBehaviorService {
  CharacterBehaviorService(this._getHost, {math.Random? random})
      : _random = random ?? math.Random();

  final AliyaLive2DHost? Function() _getHost;
  final math.Random _random;

  /// Live2D 随机动作库（业务语义名 → Native 动作 id）。
  static const List<String> live2dActionLibrary = [
    'nod', 'sway', 'shake', 'stretch', 'wave', 'doubt', 'angry', 'yawn', 'walk',
  ];

  /// 自动动作间隔范围（秒）。
  static const int _autoActionMinSeconds = 8;
  static const int _autoActionMaxSeconds = 16;

  /// 视线跟随模式。
  GazeFollowMode gazeFollowMode = GazeFollowMode.always;

  /// 视线跟随开关。
  bool lookAtEnabled = true;

  /// 渲染镜像时，视线输入也要水平翻转。
  bool mirrorX = false;

  /// 自动随机动作开关。
  bool autoActions = true;

  /// 随机台词开关。
  bool randomSpeechEnabled = false;

  /// 随机台词间隔（分钟）。
  int randomSpeechIntervalMinutes = 5;

  /// 是否正在播放动作（保留接口：动作可互相打断，此值恒为 false）。
  bool get isActionPlaying => false;

  /// 是否正在拖动（拖动期间不触发自动动作与视线跟随）。
  bool isDragging = false;

  /// 宠物是否运行。
  bool petRunning = true;

  // 内部状态
  Timer? _autoActionTimer;
  Timer? _randomSpeechTimer;

  /// 视线目标回调（用于调试/UI 显示，可选）。
  void Function(double x01, double y01)? onLookTargetChanged;

  /// 随机台词触发回调（上层播放一条随机台词）。
  void Function()? onRandomSpeech;

  /// 启动自动行为（自动动作 + 随机台词）。
  void start() {
    petRunning = true;
    _scheduleNextAutoAction();
    _scheduleNextRandomSpeech();
  }

  /// 停止自动行为。
  void stop() {
    petRunning = false;
    _autoActionTimer?.cancel();
    _randomSpeechTimer?.cancel();
  }

  /// 释放资源。
  void dispose() {
    stop();
    _getHost()?.clearLookTarget();
  }

  // ---------- 动作调度 ----------

  /// 随机选一个动作名（不播放）。
  String randomActionName() =>
      live2dActionLibrary[_random.nextInt(live2dActionLibrary.length)];

  /// 播放一个随机动作（可选附带随机台词）。
  Future<void> playRandomAction({bool speak = false}) async {
    final name = randomActionName();
    await playAction(name);
    if (speak) {
      onRandomSpeech?.call();
    }
  }

  /// 播放指定动作（点击即播，动作可互相打断，不等待完成）。
  Future<void> playAction(String name) async {
    final host = _getHost();
    if (host == null) return;
    _autoActionTimer?.cancel();
    try {
      host.playAction(name);
    } catch (_) {
      // 动作播放失败不影响后续
    }
    _scheduleNextAutoAction();
  }

  void _scheduleNextAutoAction() {
    _autoActionTimer?.cancel();
    if (!petRunning || !autoActions) return;
    _autoActionTimer = Timer(
      Duration(seconds: _random.nextInt(
              _autoActionMaxSeconds - _autoActionMinSeconds + 1) +
          _autoActionMinSeconds),
      () async {
        if (petRunning && autoActions && !isDragging) {
          await playRandomAction(speak: false);
        }
        _scheduleNextAutoAction();
      },
    );
  }

  void _scheduleNextRandomSpeech() {
    _randomSpeechTimer?.cancel();
    if (!petRunning || !randomSpeechEnabled) return;
    _randomSpeechTimer = Timer(
      Duration(minutes: randomSpeechIntervalMinutes),
      () {
        if (petRunning && randomSpeechEnabled && !isDragging) {
          onRandomSpeech?.call();
        }
        _scheduleNextRandomSpeech();
      },
    );
  }

  // ---------- 视线跟随 ----------

  /// 更新视线目标（由上层每帧/指针移动时调用）。
  /// [pointerNormX]/[pointerNormY]：指针相对角色渲染区域的归一化坐标（0..1）。
  void updateLookTarget(double pointerNormX, double pointerNormY) {
    final host = _getHost();
    if (host == null) return;
    if (!lookAtEnabled || !petRunning || isDragging) {
      if (!lookAtEnabled) {
        host.clearLookTarget();
      }
      return;
    }

    if (gazeFollowMode == GazeFollowMode.nearby) {
      // 人物附近跟随：指针离开角色区域（外扩缓冲）→ 清除目标
      const margin = 0.05; // 约 28px / 512px 视口
      if (pointerNormX < -margin ||
          pointerNormX > 1 + margin ||
          pointerNormY < -margin ||
          pointerNormY > 1 + margin) {
        host.clearLookTarget();
        return;
      }
    }

    // 视口归一化 → Native LookTarget（0..1）。
    // x：窗口水平位置直接映射；y：窗口坐标向下为正，但 Live2D 视线向上为正，
    // 因此翻转 y（窗口底部 → 视线向下看）。
    final rawX = pointerNormX.clamp(0.0, 1.0);
    final x01 = mirrorX ? (1.0 - rawX).clamp(0.0, 1.0) : rawX;
    final y01 = (1.0 - pointerNormY).clamp(0.0, 1.0);
    try {
      host.setLookTarget(x01, y01);
      onLookTargetChanged?.call(x01, y01);
    } catch (_) {
      // 忽略
    }
  }

  /// 清除视线目标（指针离开窗口等）。
  void clearLookTarget() {
    _getHost()?.clearLookTarget();
  }
}
