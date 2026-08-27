import 'dart:math' as math;

import '../../models/interaction/interaction_context.dart';
import '../../models/interaction/procedural_reaction.dart';
import 'click_sequence_service.dart';
import 'drag_reaction_service.dart';
import 'head_petting_service.dart';
import 'hit_area_service.dart';
import 'interaction_state_service.dart';
import 'petting_reaction_controller.dart';
import 'pointer_proximity_service.dart';
import 'procedural_reaction_service.dart';

/// 人物互动统一入口：区域识别、手势识别、台词抽取与参数动画全部集中在此服务。
/// 上层仅转发指针输入并负责指针/气泡/手掌指针的呈现。
class InteractionService {
  InteractionService({
    required this.hitArea,
    required this.clickSequence,
    required this.proximity,
    required this.dragReaction,
    required this.headPetting,
    required this.reaction,
    required this.procedural,
    required this.stateService,
  });

  final HitAreaService hitArea;
  final ClickSequenceService clickSequence;
  final PointerProximityService proximity;
  final DragReactionService dragReaction;
  final HeadPettingService headPetting;
  final PettingReactionController reaction;
  final ProceduralReactionService procedural;
  final InteractionStateService stateService;

  /// 点击台词请求（上层提供：播放一条 user_click 台词）。
  void Function()? playClickDialogue;

  /// 当前是否有台词在播放（上层提供）。
  bool Function()? isDialogueActive;

  // M1 修复：追踪指针位置以计算拖动速度
  double _lastPxX = 0;
  double _lastPxY = 0;

  bool get isPettingModeActive => headPetting.isPettingModeActive;

  /// 当前平滑水平速度（供手掌指针旋转）。
  double get smoothedVelocityXPxPerSec => headPetting.smoothedVelocityXPxPerSec;

  /// 加载互动配置（相对 Assets 根目录）。
  void initialize(String assetsRoot) {
    hitArea.loadFromDirectory(assetsRoot);
    stateService.ensureFresh();
  }

  /// 指针进入。返回 true=已接管。
  bool onPointerEnter(InteractionContext ctx) {
    proximity.update(ctx);
    return false;
  }

  void onPointerLeave() {
    proximity.reset();
  }

  /// 指针移动。返回 true=互动已接管（上层不移动窗口/不处理拖动）。
  bool onPointerMove(InteractionContext ctx) {
    proximity.update(ctx);

    // M1 修复：把拖动速度喂给 dragReaction，使快速拖动反应链生效
    if (dragReaction.isDragging && ctx.deltaSeconds > 0) {
      final dx = ctx.viewportPxX - _lastPxX;
      final dy = ctx.viewportPxY - _lastPxY;
      final distance = math.sqrt(dx * dx + dy * dy);
      final speed = distance / ctx.deltaSeconds;
      dragReaction.onDragMove(speed);
    }
    _lastPxX = ctx.viewportPxX;
    _lastPxY = ctx.viewportPxY;

    if (headPetting.onPointerMove(ctx)) return true;
    return false;
  }

  /// 左键按下。返回 true=互动已接管（上层不开始拖动）。
  bool onPointerDown(InteractionContext ctx) {
    proximity.update(ctx);
    // M1 修复：记录初始位置
    _lastPxX = ctx.viewportPxX;
    _lastPxY = ctx.viewportPxY;

    if (headPetting.onPointerDown(ctx)) return true;
    if (!isPettingModeActive) {
      dragReaction.beginDrag();
    }
    return false;
  }

  /// 左键松开。返回 true=互动已接管（上层不处理单击/贴边）。
  bool onPointerUp(InteractionContext ctx) {
    proximity.update(ctx);
    if (headPetting.onPointerUp(ctx)) return true;
    return false;
  }

  /// 普通单击（非抚摸接管，上层在单击确认后调用）。
  /// 返回 true 表示应抑制常规点击台词（点击冷却/疑惑反应等）。
  bool onClick(InteractionContext ctx, bool wasDrag) {
    if (wasDrag) {
      // M2 修复：endDrag 简化为单一布尔返回
      final wasFast = dragReaction.endDrag();
      if (wasFast) {
        procedural.apply(ProceduralReaction.eyesWiden(1.0));
        // 每次快速拖动触发一次台词
        if (isDialogueActive?.call() != true) {
          playClickDialogue?.call();
        }
      }
      return false;
    }

    final result = clickSequence.registerClick();
    if (result == ClickResult.cooldown) {
      // 点击冷却中，抑制点击台词
      return true;
    }

    final area = hitArea.hitAreaAt(ctx.normX, ctx.normY);
    switch (area) {
      case 'head':
        procedural.apply(ProceduralReaction.eyesAndTilt(0.8));
        break;
      case 'face':
        // 点脸脸红：全局视线跟随光标，故不使用"移开视线"反应（会互相冲突）。
        procedural.apply(ProceduralReaction.blush(1.0));
        break;
      case 'ear_left':
      case 'ear_right':
        procedural.apply(ProceduralReaction.earTwitch(0.8, area!));
        break;
    }

    if (result == ClickResult.doubt) {
      procedural.apply(ProceduralReaction.doubt(0.9));
      return true; // 疑惑反应替代常规点击台词
    }
    return false;
  }

  void onEsc() {
    headPetting.onEsc();
  }

  void togglePettingMode() {
    headPetting.enterPettingMode();
  }

  void exitPettingMode(String reason) {
    headPetting.exitPettingMode(reason);
  }

  /// 切换角色 / 重载 Live2D 模型时调用：退出抚摸并重置互动参数。
  void onModelReloaded() {
    exitPettingMode('model_reload');
    reaction.resetConfiguration();
    procedural.cancelAll();
  }

  /// 隐藏人物 / 关闭窗口时调用：完整清理，不残留定时器与参数覆盖。
  void onWindowClosed() {
    exitPettingMode('window_closed');
    procedural.cancelAll();
    clickSequence.reset();
    proximity.reset();
    headPetting.dispose();
  }

  /// 设置命中区域调试开关（半透明轮廓）。
  void setHitAreaDebug(bool enabled) {
    hitArea.debugEnabled = enabled;
  }
}
