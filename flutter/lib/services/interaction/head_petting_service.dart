import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import '../../models/dialogue/resolved_dialogue.dart';
import '../../models/interaction/interaction_context.dart';
import '../../models/interaction/petting_end_reason.dart';
import '../../models/interaction/petting_state.dart';
import '../dialogue/dialogue_playback_service.dart';
import 'hit_area_service.dart';
import 'interaction_state_service.dart';
import 'petting_gesture_recognizer.dart';
import 'petting_reaction_controller.dart';

/// 抚摸台词宿主（由上层实现：取消当前会话并播放）。
abstract class PettingDialogueHost {
  /// 当前是否正在播放高优先级台词（抚摸开始台词不打断它）。
  bool get isDialogueActive;

  /// 播放一条抚摸台词（会取消之前的台词会话，气泡由统一管道控制）。
  void playPettingDialogue(ResolvedDialogue resolved);
}

/// 抚摸模式状态机：
///   Inactive → Armed → HoveringHead → Pressed → Petting → Finishing → Armed
///   任意状态 Esc / 再次点击按钮 / 切换角色 / 重载模型 / 关闭 → Inactive
/// 所有结束路径统一走 endPettingSession(PettingEndReason)。
class HeadPettingService {
  HeadPettingService({
    required this.hitArea,
    required this.recognizer,
    required this.reaction,
    required this.stateService,
    required this.playback,
    required this.host,
  });

  final HitAreaService hitArea;
  final PettingGestureRecognizer recognizer;
  final PettingReactionController reaction;
  final InteractionStateService stateService;
  final DialoguePlaybackService playback;
  final PettingDialogueHost host;

  final math.Random _random = math.Random();
  Timer? _timer;

  DateTime _sessionStart = DateTime.now();
  int _sessionElapsedMs = 0;
  int _lastSoftOrActiveMs = 0;
  int _softActiveCount = 0;
  bool _fastTriggered = false;
  bool _longTriggered = false;
  bool _endDialogueTriggered = false;
  DateTime _finishingStart = DateTime.now();
  bool _sessionEnding = false;
  DateTime? _lastGestureUtc;

  PettingState state = PettingState.inactive;

  bool get isPettingModeActive => state != PettingState.inactive;

  /// 当前是否有激活的抚摸会话（Pressed/Petting/Finishing）。
  bool get isPettingSessionActive =>
      state == PettingState.pressed ||
      state == PettingState.petting ||
      state == PettingState.finishing;

  /// 抚摸会话结束回调（上层用于释放鼠标捕获与更新光标）。
  void Function(PettingEndReason)? onSessionEnded;

  /// 抚摸模式切换回调。
  void Function(bool)? onPettingModeChanged;

  /// 最近一次有效手势采样时间（安全兜底用）。
  DateTime? get lastActiveGestureUtc => _lastGestureUtc;

  /// 当前平滑水平速度（供手掌指针旋转）。
  double get smoothedVelocityXPxPerSec => recognizer.smoothedVelXPxPerSec;

  /// 设置抚摸输入采样率（30/60Hz）。
  void setInputRateHz(int hz) {
    recognizer.sampleIntervalSeconds = 1.0 / hz.clamp(30, 60);
  }

  void enterPettingMode() {
    if (state == PettingState.inactive) {
      stateService.ensureFresh();
      _setState(PettingState.armed);
      onPettingModeChanged?.call(true);
      reaction.start();
    } else {
      exitPettingMode('toggle_off');
    }
  }

  void exitPettingMode(String reason) {
    if (state == PettingState.inactive) return;
    // 会话激活时先走统一结束恢复，再进入 Inactive
    if (isPettingSessionActive) {
      endPettingSession(_mapExitReason(reason));
    }
    _cancelGesture();
    reaction.resetAll();
    reaction.stop();
    _sessionEnding = false;
    _setState(PettingState.inactive);
    onPettingModeChanged?.call(false);
  }

  /// 指针移动。返回 true 表示互动已接管（上层不再移动窗口）。
  bool onPointerMove(InteractionContext ctx) {
    final inZone = hitArea.isInHeadPetZone(ctx.normX, ctx.normY);

    // 不再悬停自动进入抚摸模式（避免鼠标正常掠过头部即触发闭眼）。
    // 抚摸模式仅通过明确的按下头部（onPointerDown）进入。
    if (!isPettingModeActive) {
      return false;
    }

    if (state == PettingState.armed ||
        state == PettingState.hoveringHead ||
        state == PettingState.finishing) {
      if (state == PettingState.armed && inZone) {
        _setState(PettingState.hoveringHead);
      } else if (state == PettingState.hoveringHead && !inZone) {
        _setState(PettingState.armed);
      }
    }

    if (state == PettingState.pressed || state == PettingState.petting) {
      final result = recognizer.update(ctx);
      _lastGestureUtc = DateTime.now().toUtc();
      reaction.setVelocity(result.smoothedVelXPxPerSec, petting: true);
      if (result.isValid && state == PettingState.pressed) {
        reaction.beginEyeClose(); // 识别到抚摸手势（按住并滑动）后闭眼
        _setState(PettingState.petting);
        _onPettingStarted();
      }
      return true;
    }
    return false;
  }

  /// 左键按下。返回 true 表示互动已接管（上层不开始拖动/单击）。
  ///
  /// 抚摸仅允许右键触发（Windows）；左键留给拖动桌宠/普通点击。
  /// Android 触摸无右键，保持主键（primary）抚摸。
  bool onPointerDown(InteractionContext ctx) {
    // Windows：抚摸只允许右键，左键一律不接管（交还上层做拖动/单击）
    if (Platform.isWindows && !ctx.isSecondaryButton) return false;

    // 自动抚摸模式兜底：按下时若尚未进入但位于头部区域，先自动进入
    final inZone = hitArea.isInHeadPetZone(ctx.normX, ctx.normY);
    if (!isPettingModeActive) {
      if (inZone) {
        enterPettingMode();
      } else {
        return false;
      }
    }

    if (state == PettingState.armed ||
        state == PettingState.hoveringHead ||
        state == PettingState.finishing) {
      if (inZone) {
        _sessionEnding = false; // 先取消旧恢复再创建新会话
        _sessionStart = DateTime.now();
        _sessionElapsedMs = 0;
        _softActiveCount = 0;
        _lastSoftOrActiveMs = 0;
        _fastTriggered = false;
        _longTriggered = false;
        _endDialogueTriggered = false;
        _lastGestureUtc = DateTime.now().toUtc();
        recognizer.startGesture();
        // 不立即闭眼：单击头部应走普通点击互动；仅当识别到抚摸手势（按住并滑动）后才闭眼
        stateService.beginPetting();
        _setState(PettingState.pressed);
        return true;
      }
      // 按住身体区域：不判为抚摸，交还上层（正常拖动/单击）
      return false;
    }
    return false;
  }

  /// 左键松开。返回 true 表示互动已接管。
  bool onPointerUp(InteractionContext ctx) {
    if (state == PettingState.pressed || state == PettingState.petting) {
      endPettingSession(PettingEndReason.mouseReleased);
      return true;
    }
    return false;
  }

  /// 统一结束方法：停止采样/清空样本 → Finishing → 睁眼恢复 → 头部/耳朵回正。
  /// 所有结束路径都必须调用。
  void endPettingSession(PettingEndReason reason) {
    if (!isPettingSessionActive || _sessionEnding) return;
    _sessionEnding = true;

    // 1-2. 停止轨迹采样并清空样本
    recognizer.endGesture();
    // 3. 状态切换为 Finishing（参数恢复由 PettingReactionController 平滑完成）
    _setState(PettingState.finishing);
    // 4-7. 取消参数更新：头部/耳朵目标归 0、EyeOverride 平滑睁眼
    reaction.setVelocity(0, petting: false);
    reaction.beginEyeOpen();

    final durationMs = DateTime.now().difference(_sessionStart).inMilliseconds;
    stateService.endPetting(durationMs);

    // 结束台词：仅用户主动结束且时长 > 1s 时小概率触发
    if (durationMs > 1000 &&
        !_endDialogueTriggered &&
        (reason == PettingEndReason.mouseReleased ||
            reason == PettingEndReason.pointerOutsideTolerance) &&
        _random.nextDouble() < 0.30) {
      _endDialogueTriggered = true;
      _playTag('petting_end');
    }

    _finishingStart = DateTime.now();
    // 释放人物层鼠标捕获 + 更新光标（由上层处理）
    onSessionEnded?.call(reason);
  }

  void onEsc() {
    if (isPettingModeActive) {
      exitPettingMode('esc');
    }
  }

  void _onPettingStarted() {
    if (host.isDialogueActive) return;
    if (_random.nextDouble() >= 0.40) return;

    final count = stateService.pettingCountToday;
    final repeatChance =
        count >= 2 ? math.min(0.8, 0.25 + 0.15 * (count - 2)) : 0.0;
    final tag = _random.nextDouble() < repeatChance ? 'petting_repeat' : 'petting_start';
    final boost = tag == 'petting_repeat' ? count.toDouble() : 0.0;
    _playTag(tag, boost);
  }

  void _updateTimer() {
    if (!isPettingModeActive) return;

    if (state == PettingState.finishing) {
      // 恢复参数（约 600ms）后回到 Armed
      if (DateTime.now().difference(_finishingStart).inMilliseconds >= 600) {
        _sessionEnding = false;
        _setState(PettingState.armed);
      }
      return;
    }

    if (state != PettingState.petting) return;

    _sessionElapsedMs += 33;

    // 持续过快 0.8s 以上：每次会话最多一条 petting_fast
    if (!_fastTriggered &&
        _sessionElapsedMs > 800 &&
        recognizer.smoothedVelXPxPerSec.abs() > 250) {
      _fastTriggered = true;
      _playTag('petting_fast');
      return;
    }

    // 持续约 10 秒：每次会话最多一条 petting_long
    if (!_longTriggered && _sessionElapsedMs >= 10000) {
      _longTriggered = true;
      _playTag('petting_long');
      return;
    }

    // 持续 2~4 秒起触发 petting_soft / petting_active；最多 2 条，间隔至少 4 秒
    if (_softActiveCount < 2 &&
        _sessionElapsedMs >= 2000 &&
        _sessionElapsedMs - _lastSoftOrActiveMs >= 4000 &&
        !host.isDialogueActive &&
        _random.nextDouble() < 0.6) {
      _softActiveCount++;
      _lastSoftOrActiveMs = _sessionElapsedMs;
      final tag = _random.nextDouble() < 0.5 ? 'petting_soft' : 'petting_active';
      _playTag(tag);
    }
  }

  void _playTag(String tag, [double boost = 0]) {
    final resolved = playback.resolveSceneTag(
      'head_petting',
      tag,
      excludeIds: stateService.state.lastPettingDialogueIds.toSet(),
      weightBoost: boost,
    );
    if (resolved == null) return;
    stateService.recordDialogueId(resolved.entry.id ?? '');
    host.playPettingDialogue(resolved);
  }

  static PettingEndReason _mapExitReason(String reason) {
    switch (reason) {
      case 'esc':
        return PettingEndReason.escapePressed;
      case 'model_reload':
        return PettingEndReason.nativeError;
      case 'window_closed':
        return PettingEndReason.windowClosing;
      case 'switch_character':
        return PettingEndReason.characterChanged;
      default:
        return PettingEndReason.modeChanged;
    }
  }

  void _cancelGesture() {
    recognizer.endGesture();
    _timer?.cancel();
  }

  void _setState(PettingState next) {
    if (state == next) return;
    state = next;
    if (isPettingModeActive && next == PettingState.petting) {
      _startTimer();
    } else if (next == PettingState.finishing) {
      _startTimer();
    } else if (next == PettingState.armed) {
      _startTimer();
    } else if (next == PettingState.inactive) {
      _timer?.cancel();
    }
  }

  void _startTimer() {
    if (_timer != null && _timer!.isActive) return;
    _timer = Timer.periodic(
        const Duration(milliseconds: 33), (_) => _updateTimer());
  }

  /// 释放资源（应用退出）。
  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}
