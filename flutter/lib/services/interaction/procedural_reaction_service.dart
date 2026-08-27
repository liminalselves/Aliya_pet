import 'dart:async';

import '../../models/interaction/procedural_reaction.dart';
import 'petting_reaction_controller.dart';

/// 程序化互动反应：点击 head（闭眼+头部倾斜）、face（短暂移开视线）、
/// 耳朵（小幅耳动）、快速拖动（睁大）、连续点击（疑惑）。
/// 通过同一组 Native 互动通道实现，不新增动作 JSON。
class ProceduralReactionService {
  ProceduralReactionService({
    required this.getTarget,
    required this.isPettingActive,
    required this.playCharacterAction,
  });

  final InteractionTarget? Function() getTarget;
  final bool Function() isPettingActive;
  final bool Function(String action) playCharacterAction;

  Timer? _timer;

  // 阶段数据
  final List<_Phase> _phases = [];
  int _phaseIndex = 0;
  int _phaseStartMs = 0;
  _Phase _prev = _neutral;

  // 当前实际写入值（平滑）
  double _eyeOpen = 1;
  double _headX = 0, _headY = 0, _headZ = 0, _earL = 0, _earR = 0;
  double _cheek = 0;
  bool _eyeOverrideActive = false;

  static const _Phase _neutral = _Phase(0, 1, 0, 0, 0, 0, 0);

  /// 应用一个程序化反应。
  void apply(ProceduralReaction reaction) {
    if (isPettingActive()) return; // 抚摸模式期间不叠加程序化反应
    if (getTarget() == null) return;

    switch (reaction.type) {
      case ProceduralReactionType.headTiltAndEyes:
        _start([
          const _Phase(180, 0.85, 2.5, 0, -3, 0, 0),
          const _Phase(320, 0.85, 2.5, 0, -3, 0, 0),
          const _Phase(320, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case ProceduralReactionType.lookAtThenAway:
        _start([
          const _Phase(180, 1.0, 0, 1.8, 0, 0, 0),
          const _Phase(300, 1.0, 0, 1.8, 0, 0, 0),
          const _Phase(300, 1.0, 0, -1.2, 0, 0, 0),
        ]);
        break;
      case ProceduralReactionType.earTwitch:
        final left = reaction.areaId == 'ear_left';
        _start([
          _Phase(120, 1.0, 0, 0, left ? -1.5 : 1.5, left ? 0.8 : 0, left ? 0 : 0.8),
          const _Phase(200, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case ProceduralReactionType.eyesWiden:
        // M6 修复：眼睛睁大反应（1.0 → 1.3 → 1.0）
        _start([
          const _Phase(180, 1.3, 0, 0, 0, 0, 0),  // 快速睁大
          const _Phase(260, 1.3, 0, 0, 0, 0, 0),  // 保持睁大
          const _Phase(300, 1.0, 0, 0, 0, 0, 0),  // 平滑回正
        ]);
        break;
      case ProceduralReactionType.doubt:
        playCharacterAction('doubt');
        _start([
          const _Phase(200, 0.4, -3, 0, 4, 0, 0),
          const _Phase(400, 0.45, -3, 0, 4, 0, 0),
          const _Phase(300, 1.0, 0, 0, 0, 0, 0),
        ]);
        break;
      case ProceduralReactionType.blush:
        // 脸红：不依赖视线/头部（避免与全局视线跟随冲突）。
        _start([
          _Phase(300, 1.0, 0, 0, 0, 0, 0, cheek: 0.55 * reaction.strength),
          _Phase(900, 1.0, 0, 0, 0, 0, 0, cheek: 0.55 * reaction.strength),
          _Phase(700, 1.0, 0, 0, 0, 0, 0, cheek: 0.0),
        ]);
        break;
      case ProceduralReactionType.none:
        break;
    }
  }

  void cancelAll() {
    _phases.clear();
    _phaseIndex = 0;
    _eyeOverrideActive = false;
    _eyeOpen = 1;
    _headX = _headY = _headZ = _earL = _earR = 0;
    _cheek = 0;
    final target = getTarget();
    if (target != null) {
      try {
        target.setInteractionOffsets(0, 0, 0, 0);
        target.setEyeOverride(false, 0, 0);
        target.setEarInteraction(false, 0, 0);
        target.setFaceCheek(false, 0);
      } catch (_) {}
    }
    _timer?.cancel();
  }

  void _start(List<_Phase> phases) {
    _phases
      ..clear()
      ..addAll(phases);
    _phaseIndex = 0;
    _phaseStartMs = DateTime.now().millisecondsSinceEpoch;
    _prev = _neutral;
    _eyeOverrideActive = true;
    if (_phases.isEmpty) {
      _phases.add(_neutral);
    }
    _timer?.cancel();
    _timer = Timer.periodic(
        const Duration(milliseconds: 33), (_) => _tick());
  }

  void _tick() {
    final target = getTarget();
    if (target == null) {
      _timer?.cancel();
      return;
    }

    if (_phases.isEmpty) {
      _timer?.cancel();
      return;
    }

    final now = DateTime.now().millisecondsSinceEpoch;
    final t = (now - _phaseStartMs) / 1000.0;
    if (_phaseIndex >= _phases.length) {
      // 已结束：回到中性
      _eyeOpen = 1;
      _headX = _headY = _headZ = _earL = _earR = 0;
      _cheek = 0;
      _eyeOverrideActive = false;
      _phases.clear();
      _timer?.cancel();
    } else {
      final phase = _phases[_phaseIndex];
      final k = (t / (phase.durationMs / 1000.0).clamp(0.001, 1e9)).clamp(0.0, 1.0);
      _eyeOpen = _prev.eyeOpen + (phase.eyeOpen - _prev.eyeOpen) * k;
      _headX = _prev.headX + (phase.headX - _prev.headX) * k;
      _headY = _prev.headY + (phase.headY - _prev.headY) * k;
      _headZ = _prev.headZ + (phase.headZ - _prev.headZ) * k;
      _earL = _prev.earL + (phase.earL - _prev.earL) * k;
      _earR = _prev.earR + (phase.earR - _prev.earR) * k;
      _cheek = _prev.cheek + (phase.cheek - _prev.cheek) * k;

      if (k >= 1.0) {
        _prev = phase;
        _phaseIndex++;
        _phaseStartMs = now;
      }
    }

    try {
      target.setInteractionOffsets(_headX, _headY, _headZ, 0);
      if (_eyeOverrideActive) {
        target.setEyeOverride(true, _eyeOpen, _eyeOpen);
      } else {
        target.setEyeOverride(false, 0, 0);
      }
      target.setEarInteraction(_earL != 0 || _earR != 0, _earL, _earR);
      target.setFaceCheek(_cheek != 0, _cheek);
    } catch (_) {
      // 写入失败忽略
    }
  }
}

class _Phase {
  const _Phase(this.durationMs, this.eyeOpen, this.headX, this.headY,
      this.headZ, this.earL, this.earR, {this.cheek = 0});

  final int durationMs;
  final double eyeOpen;
  final double headX;
  final double headY;
  final double headZ;
  final double earL;
  final double earR;

  /// 脸红强度（ParamCheek 0..1）。
  final double cheek;
}
