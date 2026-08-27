import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'live2d_view.dart';
import 'pet_controller.dart';
import 'pet_stage.dart';
import 'services/scale_policy.dart';
import 'services/settings_service.dart';

/// 悬浮窗独立引擎实现（入口壳函数 overlayMain 在 main.dart 根库，Flutter 引擎只在根库解析 entrypoint）。
Future<void> overlayMainImpl() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const OverlayApp());
}

class OverlayApp extends StatelessWidget {
  const OverlayApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: OverlayPet(),
    );
  }
}

/// 悬浮窗桌宠（Android）。
///
/// 与 PC 端对齐的行为：
/// - 窗口尺寸随 scale 调整（双指捏合缩放 → 原生侧 updateViewLayout）；
/// - 加载持久化设置（scale/镜像/自动动作），并被主 App 的设置变更通知刷新；
/// - 视口尺寸取真实窗口逻辑尺寸（修复：此前把物理像素当逻辑坐标，
///   高分屏上命中区域整体偏移）。
class OverlayPet extends StatefulWidget {
  const OverlayPet({super.key});

  @override
  State<OverlayPet> createState() => _OverlayPetState();
}

class _OverlayPetState extends State<OverlayPet> {
  PetController? _controller;
  bool _ready = false;
  String? _error;

  static const _channel = MethodChannel('top.liminalselves.aliyapet/overlay_control');

  /// scale=1 的目标窗口单位尺寸（native scale 仍为 1 的启动瞬间捕获，逻辑口径）。
  ({double width, double height})? _unitSize;

  /// 设备可用缩放范围（由屏幕尺寸推导，窗口随 scale 调整，策略同 PC）。
  ({double min, double max}) _scaleRange = (
    min: ScalePolicy.absoluteMin,
    max: ScalePolicy.absoluteMax,
  );

  double _dpr = 1.0;
  double? _pinchBaseScale;

  // 窗口 resize/移动通道调用的节流与防重入。
  bool _resizeBusy = false;
  DateTime _lastResizeCall = DateTime.fromMillisecondsSinceEpoch(0);

  // 拖动手柄的亚像素位移累计（通道只传整物理像素）。
  double _moveRemainderX = 0;
  double _moveRemainderY = 0;

  double get _renderRatio => math.min(_dpr, 2.0);

  @override
  void initState() {
    super.initState();
    _channel.setMethodCallHandler(_handleChannelCall);
    _boot();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _boot() async {
    try {
      _dpr = _currentDpr();
      // 初始视口仅作占位，首帧后由 LayoutBuilder 校准为真实窗口尺寸。
      final controller = PetController(viewportWidth: 420, viewportHeight: 640);
      await controller.initialize();

      // 捕获 scale=1 的单位窗口尺寸（必须在任何 setScale 之前）。
      _unitSize = controller.host.modelTargetSize;
      controller.renderPixelRatio = _renderRatio;

      // 悬浮窗与主 App 共用 SharedPreferences：读取同一份设置。
      await SettingsService.instance.load();
      await _computeRange();
      await _applySettings(controller);
      // 启动即把窗口尺寸适配到保存的 scale。
      await _resizeOverlay(SettingsService.instance.scale);

      if (!mounted) return;
      setState(() {
        _controller = controller;
        _ready = true;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  double _currentDpr() {
    final views = WidgetsBinding.instance.platformDispatcher.views;
    if (views.isEmpty) return 1.0;
    final dpr = views.first.devicePixelRatio;
    return dpr > 0 ? dpr : 1.0;
  }

  /// 由屏幕尺寸推导缩放范围（窗口随 scale 调整：上限不超出屏幕，下限可交互）。
  Future<void> _computeRange() async {
    final unit = _unitSize;
    if (unit == null || unit.width < 8 || unit.height < 8) return;
    try {
      final screen =
          await _channel.invokeMethod<Map<dynamic, dynamic>>('getScreenSize');
      final sw = (screen?['width'] as num?)?.toDouble() ?? 0;
      final sh = (screen?['height'] as num?)?.toDouble() ?? 0;
      if (sw <= 0 || sh <= 0) return;
      // 全部换算为窗口物理像素口径（单位尺寸 × dpr）。
      _scaleRange = ScalePolicy.workAreaRange(
        unitW: unit.width * _dpr,
        unitH: unit.height * _dpr,
        workW: sw,
        workH: sh,
        dpr: 1.0,
      );
    } catch (_) {
      // 取不到屏幕尺寸则保持绝对范围。
    }
  }

  /// 应用持久化设置：缩放（夹紧到设备范围）/镜像/自动动作。
  Future<void> _applySettings([PetController? controller]) async {
    final c = controller ?? _controller;
    if (c == null) return;
    final s = SettingsService.instance;
    final scale = ScalePolicy.clampToRange(s.scale, _scaleRange);
    if (!ScalePolicy.sameValue(scale, s.scale)) {
      await s.saveScale(scale);
    }
    c.applyNativeScale(s.scale);
    c.setMirrored(s.mirror);
    c.behavior.autoActions = s.autoActions;
  }

  /// 主 App 经 MainActivity 转发的设置变更通知：重新加载并应用。
  Future<dynamic> _handleChannelCall(MethodCall call) async {
    if (call.method == 'reloadSettings') {
      await SettingsService.instance.load();
      await _applySettings();
      await _resizeOverlay(SettingsService.instance.scale);
    }
    return null;
  }

  /// 调整悬浮窗窗口尺寸以匹配 scale（物理像素）。
  Future<void> _resizeOverlay(double scale) async {
    final unit = _unitSize;
    if (unit == null) return;
    final w = (unit.width * scale * _dpr).round();
    final h = (unit.height * scale * _dpr).round();
    if (w < 60 || h < 80) return;
    try {
      await _channel
          .invokeMethod('resize', <String, int>{'width': w, 'height': h});
    } catch (_) {
      // 服务已停止等场景，忽略。
    }
  }

  // ---------- 双指捏合缩放（窗口尺寸跟随，行为同 PC 滚轮） ----------

  void _onPinchStart() {
    _pinchBaseScale = SettingsService.instance.scale;
  }

  void _onPinchScale(double ratio) {
    final base = _pinchBaseScale;
    final controller = _controller;
    if (base == null || controller == null || !mounted) return;

    final next = ScalePolicy.clampToRange(base * ratio, _scaleRange);
    SettingsService.instance.scale = next;
    controller.applyNativeScale(next);

    // 窗口尺寸跟随（节流 ~30Hz + 防重入），松手时还有一次最终 resize 兜底。
    final now = DateTime.now();
    if (!_resizeBusy &&
        now.difference(_lastResizeCall).inMilliseconds >= 33) {
      _lastResizeCall = now;
      _resizeBusy = true;
      _resizeOverlay(next).whenComplete(() => _resizeBusy = false);
    }
  }

  void _onPinchEnd() {
    _pinchBaseScale = null;
    if (!mounted) return;
    final v = SettingsService.instance.scale;
    _resizeOverlay(v);
    SettingsService.instance.saveScale(v);
  }

  // ---------- 拖动手柄：Flutter 侧手势 → 原生侧移动窗口 ----------

  void _onHandleDrag(Offset delta) {
    // 逻辑位移 → 物理像素，保留亚像素余量避免累积漂移。
    final dx = delta.dx * _dpr + _moveRemainderX;
    final dy = delta.dy * _dpr + _moveRemainderY;
    final ix = dx.truncate();
    final iy = dy.truncate();
    _moveRemainderX = dx - ix;
    _moveRemainderY = dy - iy;
    if (ix == 0 && iy == 0) return;
    _channel.invokeMethod('moveBy', <String, int>{'dx': ix, 'dy': iy});
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Stack(
      children: [
        if (_ready && controller != null)
          // 视口跟随真实窗口尺寸（窗口随缩放调整）。
          LayoutBuilder(
            builder: (context, constraints) {
              final logicalW = constraints.maxWidth.isFinite
                  ? constraints.maxWidth
                  : 420.0;
              final logicalH = constraints.maxHeight.isFinite
                  ? constraints.maxHeight
                  : 640.0;
              controller.viewportWidth = logicalW.round();
              controller.viewportHeight = logicalH.round();
              return PetStage(
                controller: controller,
                viewportWidth: logicalW.round(),
                viewportHeight: logicalH.round(),
                renderWidth: (logicalW * _renderRatio).round(),
                renderHeight: (logicalH * _renderRatio).round(),
                pixelFormat: PixelFormat.rgba,
                targetFps: 30,
                bubbleMaxWidth: 360,
                onPinchStart: _onPinchStart,
                onPinchScale: _onPinchScale,
                onPinchEnd: _onPinchEnd,
              );
            },
          )
        else
          Center(
            child: Text(
              _error ?? '加载中…',
              style: const TextStyle(color: Colors.white54, fontSize: 12),
            ),
          ),
        // 拖动手柄（左上角）：按住拖动移动悬浮窗。
        if (_ready)
          Positioned(
            left: 4,
            top: 4,
            child: _OverlayHandle(
              icon: Icons.drag_indicator,
              onDrag: _onHandleDrag,
            ),
          ),
        // 关闭按钮（右上角）。
        Positioned(
          right: 4,
          top: 4,
          child: GestureDetector(
            onTap: () => _channel.invokeMethod('close'),
            child: Container(
              width: 28,
              height: 28,
              decoration: const BoxDecoration(
                color: Colors.black38,
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.close, size: 16, color: Colors.white70),
            ),
          ),
        ),
      ],
    );
  }
}

/// 悬浮窗拖动手柄：半透明圆形抓手，拖动位移经回调上报（逻辑像素增量）。
class _OverlayHandle extends StatefulWidget {
  const _OverlayHandle({required this.icon, required this.onDrag});

  final IconData icon;
  final void Function(Offset delta) onDrag;

  @override
  State<_OverlayHandle> createState() => _OverlayHandleState();
}

class _OverlayHandleState extends State<_OverlayHandle> {
  Offset? _last;

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: (e) => _last = e.localPosition,
      onPointerMove: (e) {
        final last = _last;
        if (last == null) return;
        widget.onDrag(e.localPosition - last);
        _last = e.localPosition;
      },
      onPointerUp: (_) => _last = null,
      onPointerCancel: (_) => _last = null,
      child: Container(
        width: 28,
        height: 28,
        decoration: const BoxDecoration(
          color: Colors.black38,
          shape: BoxShape.circle,
        ),
        child: Icon(widget.icon, size: 16, color: Colors.white70),
      ),
    );
  }
}
