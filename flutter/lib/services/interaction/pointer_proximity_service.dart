import 'dart:math' as math;

import '../../models/interaction/interaction_context.dart';

/// 指针邻近与速度追踪（平滑滤波），供手掌旋转、脸部看向、拖动判定使用。
class PointerProximityService {
  bool _has = false;
  DateTime _lastTime = DateTime.fromMillisecondsSinceEpoch(0);
  double _lastPxX = 0;
  double _lastPxY = 0;
  double _smoothVelX = 0;
  double _smoothVelY = 0;
  double _smoothNormX = 0;
  double _smoothNormY = 0;

  void update(InteractionContext ctx) {
    final now = DateTime.now().toUtc();
    if (_has) {
      final dt = math.max(0.001, now.difference(_lastTime).inMicroseconds / 1e6);
      final velX = (ctx.viewportPxX - _lastPxX) / dt;
      final velY = (ctx.viewportPxY - _lastPxY) / dt;
      _smoothVelX = _smoothVelX * 0.6 + velX * 0.4;
      _smoothVelY = _smoothVelY * 0.6 + velY * 0.4;
    } else {
      _smoothVelX = 0;
      _smoothVelY = 0;
    }
    _lastTime = now;
    _lastPxX = ctx.viewportPxX;
    _lastPxY = ctx.viewportPxY;
    _smoothNormX = ctx.normX;
    _smoothNormY = ctx.normY;
    _has = true;
  }

  void reset() {
    _has = false;
    _smoothVelX = 0;
    _smoothVelY = 0;
  }

  double get smoothedVelXPxPerSec => _smoothVelX;
  double get smoothedVelYPxPerSec => _smoothVelY;
  double get smoothedNormX => _smoothNormX;
  double get smoothedNormY => _smoothNormY;
}
