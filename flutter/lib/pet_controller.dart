import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:path_provider/path_provider.dart';

import 'models/dialogue/resolved_dialogue.dart';
import 'models/interaction/interaction_context.dart';
import 'model_config.dart';
import 'native/aliya_live2d_bindings.dart' show AliyaInteractionParamInfoData;
import 'native/aliya_live2d_host.dart';
import 'native/live2d_asset_manager.dart';
import 'services/character_behavior_service.dart';
import 'services/dialogue/dialogue_display.dart';
import 'services/dialogue/dialogue_pagination_service.dart';
import 'services/dialogue/dialogue_playback_service.dart';
import 'services/dialogue/dialogue_repository.dart';
import 'services/dialogue/dialogue_selection_service.dart';
import 'services/dialogue/dialogue_variable_service.dart';
import 'services/dialogue/time_scene_service.dart';
import 'services/interaction/click_sequence_service.dart';
import 'services/interaction/drag_reaction_service.dart';
import 'services/interaction/head_petting_service.dart';
import 'services/interaction/hit_area_service.dart';
import 'services/interaction/interaction_service.dart';
import 'services/interaction/interaction_state_service.dart';
import 'services/interaction/petting_gesture_recognizer.dart';
import 'services/interaction/petting_reaction_controller.dart';
import 'services/interaction/pointer_proximity_service.dart';
import 'services/interaction/procedural_reaction_service.dart';
import 'services/mouth/live2d_mouth_controller.dart';
import 'services/mouth/mouth_animation_runner.dart';
import 'services/mouth/pinyin_mouth_mapper.dart';
import 'services/mouth/text_mouth_timeline_builder.dart';

/// 宠物控制器：组装 Native Host + 台词/互动/嘴型/行为服务，并向 UI 暴露状态。
///
/// 渲染循环由 [Live2DView] 驱动；指针输入由 UI 手势层调用本控制器的指针方法。
class PetController {
  PetController({required this.viewportWidth, required this.viewportHeight});

  int viewportWidth;
  int viewportHeight;

  // ---- Native ----
  late final AliyaLive2DHost host;

  // ---- 服务 ----
  late final DialogueRepository dialogueRepository;
  late final DialogueSelectionService dialogueSelection;
  late final DialogueVariableService dialogueVariables;
  late final DialoguePaginationService dialoguePagination;
  late final DialoguePlaybackService dialoguePlayback;
  late final HitAreaService hitAreaService;
  late final ClickSequenceService clickSequence;
  late final PointerProximityService proximity;
  late final DragReactionService dragReaction;
  late final InteractionStateService interactionState;
  late final PettingReactionController reaction;
  late final PettingGestureRecognizer recognizer;
  late final ProceduralReactionService procedural;
  late final HeadPettingService headPetting;
  late final InteractionService interaction;
  late final Live2DMouthController mouthController;
  late final MouthAnimationRunner mouthRunner;
  late final CharacterBehaviorService behavior;

  // ---- UI 状态 ----
  final ValueNotifier<String?> bubbleText = ValueNotifier(null);

  /// 镜像显示状态（驱动显示层 Transform 翻转 + 命中区域/视线翻转）。
  final ValueNotifier<bool> mirrored = ValueNotifier(false);

  /// 用户 scale → native scale 的换算系数。
  ///
  /// Windows 为 1.0（窗口物理尺寸随 scale 调整，native scale 即用户 scale）。
  /// Android 高分辨率渲染时为渲染像素比：native scale = 用户 scale × 该系数，
  /// 使模型在高分渲染目标中保持与逻辑视口相同的视觉占比。
  double renderPixelRatio = 1.0;

  /// 是否镜像显示（角色左右翻转）。
  bool get isMirrored => hitAreaService.isMirrored;

  /// 统一的 native scale 写入入口：所有缩放路径都必须经由此方法，
  /// 保证 Android 高分渲染换算与后续 native 侧校验只维护一处。
  void applyNativeScale(double userScale) {
    host.setScale(userScale * renderPixelRatio);
  }

  bool _initialized = false;
  bool _interactionTargetReady = false;
  Completer<void>? _initCompleter;

  /// 初始化（解包资源 → 创建 Host → 加载模型 → 组装服务）。
  ///
  /// 可重入：多次调用会等待第一个调用完成。如果第一个调用失败，
  /// 后续调用会收到相同的错误，可通过 [retryInitialize] 重置状态重试。
  Future<void> initialize() async {
    if (_initialized) return;

    // 并发保护：使用 Completer 确保只有一个调用真正执行初始化
    if (_initCompleter != null) {
      return _initCompleter!.future;
    }

    _initCompleter = Completer<void>();

    try {
      await _performInitialize();
      _initCompleter!.complete();
    } catch (e, st) {
      _initCompleter!.completeError(e, st);
      _initCompleter = null; // 允许重试
      rethrow;
    }
  }

  /// 重置初始化状态（用于失败后重试）。
  void retryInitialize() {
    if (_initialized) return;
    _initCompleter = null;
  }

  /// 实际执行初始化的内部方法（不处理并发）。
  Future<void> _performInitialize() async {
    if (_initialized) return;

    // 1. 资源解包
    final supportDir = await getApplicationSupportDirectory();
    final assetsDir = Directory('${supportDir.path}/live2d');
    final manager = Live2DAssetManager(assetsDir);
    await manager.extractAll();

    // 2. Native Host
    host = AliyaLive2DHost.create();
    host.setAssetDirectory(assetsDir.path);
    host.cachedModelJson = await manager.readModelJson(ModelConfig.modelJson);
    host.loadModel(ModelConfig.modelJson);
    host.attachWindow(viewportWidth, viewportHeight);

    // 3. GLES 后端上传纹理
    if (!Platform.isWindows) {
      await host.uploadAllTexturesFromAssets((fileName) async {
        final data = await rootBundle.load('assets/live2d/${ModelConfig.dirName}/$fileName');
        return data.buffer.asUint8List();
      });
    }

    // 4. 组装台词服务
    dialogueRepository = DialogueRepository();
    dialogueRepository.loadFromDirectory('${assetsDir.path}/dialogue');
    dialogueSelection = DialogueSelectionService(dialogueRepository);
    dialogueVariables = DialogueVariableService(TimeSceneService());
    dialoguePagination = DialoguePaginationService();
    mouthController = Live2DMouthController(() => host);
    mouthRunner = MouthAnimationRunner(mouthController);
    dialoguePlayback = DialoguePlaybackService(
      repository: dialogueRepository,
      selection: dialogueSelection,
      variables: dialogueVariables,
      pagination: dialoguePagination,
      timelineBuilder: TextMouthTimelineBuilder(PinyinMouthMapper()),
      mouthRunner: mouthRunner,
      display: _DialogueDisplayImpl(this),
    );

    // 5. 组装互动服务
    hitAreaService = HitAreaService();
    hitAreaService.loadFromDirectory(assetsDir.path);
    interactionState = InteractionStateService();
    clickSequence = ClickSequenceService();
    proximity = PointerProximityService();
    dragReaction = DragReactionService();
    recognizer = PettingGestureRecognizer();
    reaction = PettingReactionController(_interactionTarget);
    procedural = ProceduralReactionService(
      getTarget: _interactionTarget,
      isPettingActive: () => headPetting.isPettingModeActive,
      playCharacterAction: (action) {
        try {
          host.playAction(action);
          return true;
        } catch (_) {
          return false;
        }
      },
    );
    headPetting = HeadPettingService(
      hitArea: hitAreaService,
      recognizer: recognizer,
      reaction: reaction,
      stateService: interactionState,
      playback: dialoguePlayback,
      host: _PettingHostImpl(this),
    );
    interaction = InteractionService(
      hitArea: hitAreaService,
      clickSequence: clickSequence,
      proximity: proximity,
      dragReaction: dragReaction,
      headPetting: headPetting,
      reaction: reaction,
      procedural: procedural,
      stateService: interactionState,
    );
    interaction.playClickDialogue = () => _playScene('user_click');
    interaction.isDialogueActive = () => bubbleText.value != null;
    interaction.initialize(assetsDir.path);

    // 6. 行为服务
    behavior = CharacterBehaviorService(() => host);
    behavior.onRandomSpeech = () => _playRandom();
    // 视线始终跟随指针位置（指针静止也保持注视），静止回正超时设到最长 30 秒
    behavior.gazeFollowMode = GazeFollowMode.always;
    host.setMouseIdleTimeout(30.0);
    behavior.start();

    _interactionTargetReady = true;
    _initialized = true;
  }

  /// 交互目标适配器（Live2D 渲染器抽象）。
  InteractionTarget? _interactionTarget() {
    if (!_interactionTargetReady) return null;
    return _Live2DInteractionTarget(this);
  }

  /// 设置镜像显示。渲染画面、交互命中区域与视线输入同步翻转。
  void setMirrored(bool value) {
    hitAreaService.isMirrored = value;
    behavior.mirrorX = value;
    mirrored.value = value;
  }

  // ---------- 指针输入（UI 手势层调用） ----------

  InteractionContext _ctx(Offset localPos, double dt, bool pressed,
      {bool isSecondary = false}) {
    return InteractionContext(
      normX: (localPos.dx / viewportWidth).clamp(0.0, 1.0),
      normY: (localPos.dy / viewportHeight).clamp(0.0, 1.0),
      viewportPxX: localPos.dx,
      viewportPxY: localPos.dy,
      deltaSeconds: dt,
      leftPressed: pressed,
      isSecondaryButton: isSecondary,
    );
  }

  bool _pressed = false;
  DateTime _lastMoveTime = DateTime.now();

  /// 指针移动（返回 true 表示互动已接管）。
  bool onPointerMove(Offset localPos, {bool isSecondary = false}) {
    final now = DateTime.now();
    final dt = now.difference(_lastMoveTime).inMicroseconds / 1e6;
    _lastMoveTime = now;
    final ctx =
        _ctx(localPos, dt, _pressed, isSecondary: isSecondary);
    final handled = interaction.onPointerMove(ctx);
    // 视线跟随：Windows 上由 GlobalGazeTracker 统一驱动（避免双写入冲突），
    // 其他平台（Android overlay）由窗口内指针事件驱动。
    if (!Platform.isWindows) {
      behavior.updateLookTarget(ctx.normX, ctx.normY);
    }
    return handled;
  }

  /// 指针按下（同时更新视线目标，移动端点击处即注视点）。
  bool onPointerDown(Offset localPos, {bool isSecondary = false}) {
    _pressed = true;
    final ctx =
        _ctx(localPos, 0.016, true, isSecondary: isSecondary);
    if (!Platform.isWindows) {
      behavior.updateLookTarget(ctx.normX, ctx.normY);
    }
    return interaction.onPointerDown(ctx);
  }

  /// 指针抬起（返回 true 表示互动已接管）。
  bool onPointerUp(Offset localPos, {bool isSecondary = false}) {
    _pressed = false;
    final ctx =
        _ctx(localPos, 0.016, false, isSecondary: isSecondary);
    return interaction.onPointerUp(ctx);
  }

  /// 单击（wasDrag：是否刚结束一次拖动）。
  void onClick(Offset localPos, {bool wasDrag = false}) {
    final ctx = _ctx(localPos, 0.016, false);
    final suppressed = interaction.onClick(ctx, wasDrag);
    if (!suppressed && !wasDrag) {
      _playScene('user_click');
    }
  }

  /// 指针离开。
  void onPointerLeave() {
    interaction.onPointerLeave();
    // Windows 上视线由 GlobalGazeTracker 持续驱动，离开窗口不清理（避免双眼写冲突）；
    // 其他平台（Android）窗口内事件驱动，离开时回正。
    if (!Platform.isWindows) {
      behavior.clearLookTarget();
    }
  }

  // ---------- 台词 ----------

  void _playScene(String scene) {
    dialoguePlayback.cancelCurrent();
    final resolved = dialoguePlayback.resolveScene(scene);
    if (resolved != null) {
      dialoguePlayback.playAsync(resolved);
    }
  }

  void _playRandom() {
    dialoguePlayback.cancelCurrent();
    final resolved = dialoguePlayback.resolveRandom();
    if (resolved != null) {
      dialoguePlayback.playAsync(resolved);
    }
  }

  /// 托盘菜单触发的随机台词。
  void onRandomSpeechFromTray() {
    _playRandom();
  }

  // ---------- 清理 ----------

  void dispose() {
    // bubbleText/mirrored 在初始化前就已创建，始终可安全释放。
    bubbleText.dispose();
    mirrored.dispose();
    // H5 修复：以下服务均为 late final，仅在初始化完成后赋值。
    // 若初始化失败或尚未完成就 dispose，访问会抛 LateInitializationError。
    if (!_initialized) return;
    behavior.dispose();
    interaction.onWindowClosed();
    mouthRunner.stopNow();
    host.dispose();
  }

  /// 交互目标实现（桥接 Host 绑定）。
}

/// 气泡显示回调实现。
class _DialogueDisplayImpl implements DialogueDisplay {
  _DialogueDisplayImpl(this._controller);

  final PetController _controller;

  @override
  void showPage(String pageText) {
    _controller.bubbleText.value = pageText;
  }

  @override
  void hideBubble() {
    _controller.bubbleText.value = null;
  }
}

/// 抚摸台词宿主实现。
class _PettingHostImpl implements PettingDialogueHost {
  _PettingHostImpl(this._controller);

  final PetController _controller;

  @override
  bool get isDialogueActive => _controller.bubbleText.value != null;

  @override
  void playPettingDialogue(ResolvedDialogue resolved) {
    _controller.dialoguePlayback.cancelCurrent();
    _controller.dialoguePlayback.playAsync(resolved);
  }
}

/// Live2D 互动目标适配器。
class _Live2DInteractionTarget implements InteractionTarget {
  _Live2DInteractionTarget(this._controller);

  final PetController _controller;
  AliyaLive2DHost get _host => _controller.host;

  @override
  AliyaInteractionParamInfoData get interactionParamInfo =>
      _host.interactionParamInfo;

  @override
  String listEarParams() => _host.earParams.join('\n');

  @override
  void setInteractionOffsets(
      double angleX, double angleY, double angleZ, double bodyAngleX) {
    _host.bindings.setInteractionOffsets(
        _host.handle, angleX, angleY, angleZ, bodyAngleX);
  }

  @override
  void setEyeOverride(bool enabled, double leftOpen, double rightOpen) {
    _host.bindings.setEyeOverride(
        _host.handle, enabled, leftOpen, rightOpen);
  }

  @override
  void setEarInteraction(bool enabled, double leftValue, double rightValue) {
    _host.bindings.setEarInteraction(
        _host.handle, enabled, leftValue, rightValue);
  }

  @override
  void setFaceCheek(bool enabled, double value) {
    _host.setParameterValue('ParamCheek', enabled ? value : 0.0);
  }

  @override
  void setPettingLookAtReduction(bool enabled) {
    _host.bindings.setPettingLookAtReduction(_host.handle, enabled);
  }
}
