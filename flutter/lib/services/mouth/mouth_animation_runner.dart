import 'dart:async';
import 'dart:math' as math;

import '../../models/mouth/mouth_animation_frame.dart';
import '../../models/mouth/mouth_timeline.dart';
import 'mouth_controller.dart';

/// 嘴型时间轴播放器：按时间平滑写入 Live2D 嘴部参数。
///   - 时间相关的指数平滑（不依赖固定帧率，张嘴 50~90ms、闭嘴 80~140ms、句末闭合 100~180ms）
///   - 台词结束后闭嘴；会话被取消时 100~150ms 内闭合
///   - 单实例运行，同一时刻只有本播放器写参数（新会话先停止旧会话）
class MouthAnimationRunner {
  MouthAnimationRunner(this._mouth);

  static const int _tickMilliseconds = 33;
  static const int _startDelayMilliseconds = 60; // 气泡先显示，约 50~100ms 后启动嘴型

  static const double _openTauSeconds = 0.070;
  static const double _closeTauSeconds = 0.110;

  final MouthController _mouth;
  final math.Random _random = math.Random();

  Timer? _timer;
  MouthTimeline? _timeline;
  bool _cancelled = false;
  Completer<bool>? _completion;
  bool _closing = false;
  int _closeStartMs = 0;
  int _lastTickMs = 0;
  double _currentOpenY = 0;
  double _currentForm = 0;
  final Stopwatch _stopwatch = Stopwatch();

  /// 是否正在播放会话。
  bool get isRunning => _timer != null && _timer!.isActive;

  /// 启动一次会话，返回完成信号（台词结束并闭嘴后完成）。会先停止旧会话。
  Future<bool> startSession(MouthTimeline timeline,
      {bool cancelled = false}) {
    stopCurrent();

    _timeline = timeline;
    _cancelled = cancelled;
    _completion = Completer<bool>();
    _closing = false;
    _currentOpenY = 0;
    _currentForm = 0;
    _stopwatch
      ..reset()
      ..start();
    _lastTickMs = 0;
    _timer = Timer.periodic(
        const Duration(milliseconds: _tickMilliseconds), (_) => _tick());

    return _completion!.future;
  }

  /// 请求取消当前会话（100~150ms 内闭嘴后完成）。
  void requestCancel() {
    _cancelled = true;
  }

  /// 立即停止并释放嘴型通道（应用退出 / 切换角色等）。
  void stopNow() {
    stopCurrent();
  }

  void stopCurrent() {
    _timer?.cancel();
    _timer = null;
    _timeline = null;
    _closing = false;
    _mouth.release();
    final completion = _completion;
    _completion = null;
    if (completion != null && !completion.isCompleted) {
      completion.complete(false);
    }
  }

  void _tick() {
    final timeline = _timeline;
    if (timeline == null) {
      _timer?.cancel();
      _timer = null;
      return;
    }

    if (_cancelled) {
      _beginClose();
    }

    final nowMs = _stopwatch.elapsedMilliseconds;
    final elapsed = nowMs - _startDelayMilliseconds;
    final dt =
        math.max(1, nowMs - _lastTickMs) / 1000.0;
    _lastTickMs = nowMs;

    if (_closing) {
      final frame = _smoothTowards(MouthAnimationFrame.closed, dt);
      _mouth.write(frame);
      if (nowMs - _closeStartMs >= 150) {
        _finishSession();
      }
      return;
    }

    if (elapsed < 0) {
      // 启动延迟：嘴巴保持闭合，不进入闭合状态
      _mouth.write(MouthAnimationFrame.closed);
      return;
    }

    if (elapsed >= timeline.totalMilliseconds) {
      _beginClose();
      final closingFrame = _smoothTowards(MouthAnimationFrame.closed, dt);
      _mouth.write(closingFrame);
      return;
    }

    final target = _findTarget(timeline, elapsed);
    final current = _smoothTowards(target, dt);
    _mouth.write(current);
  }

  MouthAnimationFrame _smoothTowards(MouthAnimationFrame target, double dt) {
    final tau = target.openY >= _currentOpenY ? _openTauSeconds : _closeTauSeconds;
    final k = 1.0 - math.exp(-dt / tau);
    _currentOpenY += (target.openY - _currentOpenY) * k;
    _currentForm += (target.form - _currentForm) * k;

    // 轻微稳定随机变化：开合幅度 ±5%
    final wobble = 1.0 + (_random.nextDouble() - 0.5) * 0.10;
    return MouthAnimationFrame(
      (_currentOpenY * wobble).clamp(0.0, 1.0),
      _currentForm.clamp(-1.0, 1.0),
    );
  }

  MouthAnimationFrame _findTarget(MouthTimeline timeline, int elapsedMs) {
    // H1 修复：空时间轴保护
    if (timeline.items.isEmpty) {
      _beginClose();
      return MouthAnimationFrame.closed;
    }
    
    for (final item in timeline.items) {
      if (elapsedMs >= item.startMilliseconds &&
          elapsedMs < item.endMilliseconds) {
        return MouthAnimationFrame(item.shape.openY, item.shape.form);
      }
    }
    final last = timeline.items.last;
    return MouthAnimationFrame(last.shape.openY, last.shape.form);
  }

  void _beginClose() {
    if (_closing) return;
    _closing = true;
    _closeStartMs = _stopwatch.elapsedMilliseconds;
  }

  void _finishSession() {
    _timer?.cancel();
    _timer = null;
    _timeline = null;
    _closing = false;
    _currentOpenY = 0;
    _currentForm = 0;
    _mouth.release();
    final completion = _completion;
    _completion = null;
    if (completion != null && !completion.isCompleted) {
      completion.complete(true);
    }
  }
}
