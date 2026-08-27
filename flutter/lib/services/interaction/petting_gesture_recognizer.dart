import 'dart:math' as math;

import '../../models/interaction/interaction_context.dart';
import '../../models/interaction/petting_gesture_result.dart';
import '../../models/interaction/petting_gesture_sample.dart';

/// 抚摸手势识别（纯逻辑，可测试）：
///   - 采样 30~60Hz，固定容量预分配环形缓冲（索引覆盖，不分配），
///     只保留最近约 1 秒；采样频率受 sampleIntervalSeconds 限制，不被事件频率驱动。
///   - 有效条件：水平移动占主导（>60%）、起始距离 6~10px、单次划动 18~80px、
///     水平速度 40~500px/s、至少一次有效方向反转
///   - 方向反转：最小反转距离 14~24px、防抖 80~160ms、忽略 <3~5px 抖动
///   - 仅按住不移动不增加抚摸次数
class PettingGestureRecognizer {
  PettingGestureRecognizer({
    int capacity = 64,
    this.sampleWindowSeconds = 1.0,
    double sampleIntervalSeconds = 1.0 / 60.0,
  })  : _capacity = capacity,
        _samples = List.filled(capacity, _emptySample()) {
    _sampleIntervalSeconds = _clampInterval(sampleIntervalSeconds);
  }

  final int _capacity;
  final double sampleWindowSeconds;
  final double _minStartDistancePx = 8; // 6~10
  final double _minStrokeDistancePx = 18; // 18~80
  final double _maxStrokeDistanceLimitPx = 80;
  final double _minVelocityPxPerSec = 40; // 40~500
  final double _maxVelocityPxPerSec = 500;
  final double _horizontalDominance = 0.60;
  final double _minReversalDistancePx = 18; // 14~24
  final double _reversalDebounceSeconds = 0.12; // 80~160ms
  final double _jitterPx = 4; // 3~5

  // 固定容量预分配环形缓冲（索引覆盖，无堆分配）
  final List<PettingGestureSample> _samples;
  int _sampleHead = 0; // 下一个写入位置
  int _sampleCount = 0; // 有效样本数（≤ _capacity）
  double _sampleIntervalSeconds = 1.0 / 60.0;
  double _lastSampleElapsed = 0;
  double _pendingDt = 0; // 被限频跳过的累计 dt

  bool _gestureActive = false;
  double _startCumulative = 0;
  double _lastCumulative = 0;
  double _lastPxX = 0;
  double _lastPxY = 0;
  int _currentDirection = 0; // -1/0/1
  int _lastNonZeroDirection = 0;
  double _strokeStartCumulative = 0;
  double _lastReversalTime = 0;
  int _reversalCount = 0;
  double _maxStrokeDistancePx = 0;
  double _smoothedVelXPxPerSec = 0;
  double _gestureElapsed = 0;

  /// 采样间隔（秒），限制为 30~60Hz。过低时跳过样本、不判反转。
  double get sampleIntervalSeconds => _sampleIntervalSeconds;
  set sampleIntervalSeconds(double v) =>
      _sampleIntervalSeconds = _clampInterval(v);

  // M5 修复：与文档/HeadPettingService.setInputRateHz 统一为 30~60Hz
  static double _clampInterval(double v) =>
      v.clamp(1.0 / 60.0, 1.0 / 30.0).toDouble();

  static PettingGestureSample _emptySample() => PettingGestureSample(
        timeSeconds: 0,
        normX: 0,
        normY: 0,
        viewportPxX: 0,
        viewportPxY: 0,
        velXPxPerSec: 0,
        velYPxPerSec: 0,
        direction: 0,
        cumulativeDistancePx: 0,
      );

  void startGesture() {
    _gestureActive = true;
    _sampleHead = 0;
    _sampleCount = 0;
    _lastSampleElapsed = 0;
    _pendingDt = 0;
    _startCumulative = 0;
    _lastCumulative = 0;
    _lastPxX = 0;
    _lastPxY = 0;
    _currentDirection = 0;
    _lastNonZeroDirection = 0;
    _strokeStartCumulative = 0;
    _lastReversalTime = 0;
    _reversalCount = 0;
    _maxStrokeDistancePx = 0;
    _smoothedVelXPxPerSec = 0;
    _gestureElapsed = 0;
  }

  void endGesture() {
    _gestureActive = false;
    _sampleHead = 0;
    _sampleCount = 0;
    _smoothedVelXPxPerSec = 0;
    _currentDirection = 0;
  }

  bool get isGestureActive => _gestureActive;

  /// 当前平滑后的水平速度（物理像素/秒，供头部跟随与手掌旋转）。
  double get smoothedVelXPxPerSec => _smoothedVelXPxPerSec;

  /// 当前方向（-1/0/1）。
  int get currentDirection => _currentDirection;

  int get reversalCount => _reversalCount;

  double get gestureElapsedSeconds => _gestureElapsed;

  double get cumulativeDistancePx =>
      _gestureActive ? _lastCumulative - _startCumulative : 0;

  /// 压入一个新采样并返回识别结果。
  /// 距上次有效采样不足 sampleIntervalSeconds 时：累计 dt、更新指针基线，不入缓冲、不判反转。
  PettingGestureResult update(InteractionContext ctx) {
    if (!_gestureActive) return PettingGestureResult.invalid;

    // 使用调用方提供的帧间隔（真实帧率），保证确定性与可测试性
    final dt = math.max(0.001, ctx.deltaSeconds);
    _gestureElapsed += dt;

    // 采样频率限制：不足间隔直接跳过（只更新位置基线），不加入环形缓冲。
    if (_sampleCount > 0 &&
        _gestureElapsed - _lastSampleElapsed < _sampleIntervalSeconds - 0.001) {
      _pendingDt += dt;
      _lastPxX = ctx.viewportPxX;
      _lastPxY = ctx.viewportPxY;
      // 未到采样间隔：返回上一次平滑速度（保持头部目标，避免下游清零导致转向失效）
      return PettingGestureResult(
        isValid: false,
        directionReversed: false,
        direction: _currentDirection,
        smoothedVelXPxPerSec: _smoothedVelXPxPerSec,
        startDistancePx: 0,
        strokeDistancePx: 0,
      );
    }
    final sampleDt = dt + _pendingDt;
    _pendingDt = 0;
    _lastSampleElapsed = _gestureElapsed;

    final dx = ctx.viewportPxX - _lastPxX;
    final dy = ctx.viewportPxY - _lastPxY;
    final distance = math.sqrt(dx * dx + dy * dy);

    final velX = dx / sampleDt;
    final velY = dy / sampleDt;
    // 方向反转时立即换向（绕过 EMA 滞后，否则快速往返抚摸下头部 X 轴转向迟钝/错乱）。
    // 仅在水平方向符号发生变化时覆盖，不改变方向反转检测阈值与抚摸计数。
    if (dx.abs() >= _jitterPx) {
      final newDir = dx > 0 ? 1 : -1;
      if (newDir != _currentDirection && _currentDirection != 0) {
        _smoothedVelXPxPerSec = velX.clamp(-800.0, 800.0);
      } else {
        _smoothedVelXPxPerSec =
            _smoothedVelXPxPerSec * 0.7 + velX.clamp(-800.0, 800.0) * 0.3;
      }
    } else {
      _smoothedVelXPxPerSec =
          _smoothedVelXPxPerSec * 0.7 + velX.clamp(-800.0, 800.0) * 0.3;
    }

    _lastPxX = ctx.viewportPxX;
    _lastPxY = ctx.viewportPxY;
    _lastCumulative += distance;

    // 方向判定：忽略 < jitterPx 的抖动
    if (dx.abs() >= _jitterPx) {
      _currentDirection = dx > 0 ? 1 : -1;
    } else if (distance < _jitterPx) {
      _currentDirection = 0;
    }

    // 方向反转检测：划动距离 = 距上次方向变化的累计距离
    var reversed = false;
    if (_currentDirection != 0 &&
        _lastNonZeroDirection != 0 &&
        _currentDirection != _lastNonZeroDirection) {
      final strokeLen = _lastCumulative - _strokeStartCumulative;
      final timeSince = _gestureElapsed - _lastReversalTime;
      if (strokeLen >= _minReversalDistancePx &&
          timeSince >= _reversalDebounceSeconds) {
        reversed = true;
        _reversalCount++;
        if (strokeLen >= _minStrokeDistancePx &&
            strokeLen <= _maxStrokeDistanceLimitPx) {
          _maxStrokeDistancePx = math.max(_maxStrokeDistancePx, strokeLen);
        }
        _strokeStartCumulative = _lastCumulative;
        _lastReversalTime = _gestureElapsed;
      }
    } else if (_currentDirection != 0 && _lastNonZeroDirection == 0) {
      // 首次产生方向：标记当前划动起点
      _strokeStartCumulative = _lastCumulative;
      _lastReversalTime = _gestureElapsed;
    }
    if (_currentDirection != 0) {
      _lastNonZeroDirection = _currentDirection;
    }

    final sample = PettingGestureSample(
      timeSeconds: _gestureElapsed,
      normX: ctx.normX,
      normY: ctx.normY,
      viewportPxX: ctx.viewportPxX,
      viewportPxY: ctx.viewportPxY,
      velXPxPerSec: velX,
      velYPxPerSec: velY,
      direction: _currentDirection,
      cumulativeDistancePx: _lastCumulative,
    );
    _samples[_sampleHead] = sample; // 索引覆盖，不分配
    _sampleHead = (_sampleHead + 1) % _capacity;
    if (_sampleCount < _capacity) _sampleCount++;

    // 只保留最近约 1 秒（从最旧端修剪）
    while (_sampleCount > 0) {
      final oldest = _samples[_oldestIndex];
      if (_gestureElapsed - oldest.timeSeconds <= sampleWindowSeconds) break;
      _sampleCount--;
    }

    final (bool valid, double strokeDistance, double horizontalRatio) =
        _evaluateGesture();
    return PettingGestureResult(
      isValid: valid,
      directionReversed: reversed,
      direction: _currentDirection,
      smoothedVelXPxPerSec: _smoothedVelXPxPerSec,
      startDistancePx: _lastCumulative - _startCumulative,
      strokeDistancePx: strokeDistance,
    );
  }

  int get _oldestIndex =>
      (_sampleHead - _sampleCount + _capacity) % _capacity;

  /// 按相对序号取样本：0=最旧，count-1=最新。
  PettingGestureSample _sampleAt(int index) =>
      _samples[(_sampleHead - _sampleCount + index + _capacity) % _capacity];

  (bool, double, double) _evaluateGesture() {
    double strokeDistance = 0;
    double horizontalRatio = 0;
    if (_sampleCount < 2) return (false, strokeDistance, horizontalRatio);

    var total = 0.0;
    var horizontal = 0.0;
    var prev = _sampleAt(0);
    for (var i = 1; i < _sampleCount; i++) {
      final cur = _sampleAt(i);
      final ddx = cur.viewportPxX - prev.viewportPxX;
      final ddy = cur.viewportPxY - prev.viewportPxY;
      final seg = math.sqrt(ddx * ddx + ddy * ddy);
      total += seg;
      horizontal += ddx.abs();
      prev = cur;
    }

    if (total < _minStartDistancePx) return (false, strokeDistance, horizontalRatio);
    horizontalRatio = total > 0 ? horizontal / total : 0;
    if (horizontalRatio < _horizontalDominance) {
      return (false, strokeDistance, horizontalRatio);
    }

    // 水平速度 40~500px/s（取平滑速度）
    final vel = _smoothedVelXPxPerSec.abs();
    if (vel < _minVelocityPxPerSec || vel > _maxVelocityPxPerSec) {
      return (false, strokeDistance, horizontalRatio);
    }

    // 至少一次有效方向反转；且存在一段划动距离在 18~80px
    if (_reversalCount <= 0) return (false, strokeDistance, horizontalRatio);
    strokeDistance = _maxStrokeDistancePx;
    if (strokeDistance < _minStrokeDistancePx ||
        strokeDistance > _maxStrokeDistanceLimitPx) {
      return (false, strokeDistance, horizontalRatio);
    }

    return (true, strokeDistance, horizontalRatio);
  }
}
