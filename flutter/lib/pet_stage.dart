import 'package:flutter/gestures.dart'
    show PointerScrollEvent, kSecondaryMouseButton;
import 'package:flutter/material.dart';

import 'live2d_view.dart';
import 'pet_controller.dart';

/// 宠物舞台（双端共用）：Live2D 渲染 + 台词气泡 + 指针交互 + 双指捏合缩放。
///
/// 指针分发规则：
/// - 单指/鼠标：正常转发给 [PetController]（抚摸/点击/拖动反应/视线）；
/// - 第二指落下：结束进行中的单指互动（抚摸会话、窗口拖动候选），进入捏合缩放；
/// - 捏合期间只上报 [onPinchScale]，不转发单指交互；
/// - 捏合结束后剩余手指直到全部抬起前不转发交互（防止缩放后误触点击）。
class PetStage extends StatefulWidget {
  const PetStage({
    super.key,
    required this.controller,
    required this.viewportWidth,
    required this.viewportHeight,
    this.renderWidth,
    this.renderHeight,
    this.paused = false,
    this.targetFps = 30,
    this.pixelFormat = PixelFormat.bgra,
    this.bubbleMaxWidth = 420,
    this.onWheelZoom,
    this.onDragCandidateDown,
    this.onDragCandidateMove,
    this.onDragCandidateUp,
    this.onPinchStart,
    this.onPinchScale,
    this.onPinchEnd,
  });

  final PetController controller;

  /// 逻辑视口尺寸（Flutter 事件坐标口径）。
  final int viewportWidth;
  final int viewportHeight;

  /// Live2D 渲染视口物理像素（默认等于逻辑尺寸，由调用方按渲染像素比提供）。
  final int? renderWidth;
  final int? renderHeight;

  /// resize 期间暂停渲染。
  final bool paused;

  /// 目标帧率。
  final int targetFps;

  /// 读回像素格式（Windows: bgra；Android: rgba）。
  final PixelFormat pixelFormat;

  /// 台词气泡最大宽度。
  final double bubbleMaxWidth;

  /// 滚轮缩放回调（dy>0 放大）。
  final void Function(double dy)? onWheelZoom;

  /// 窗口拖动候选：按下/移动（全局坐标）、抬起。
  final void Function(Offset globalPos)? onDragCandidateDown;
  final void Function(Offset globalPos)? onDragCandidateMove;
  final void Function()? onDragCandidateUp;

  /// 捏合缩放：开始（记录基准）、缩放比变化（相对开始时的距离比）、结束（持久化时机）。
  final void Function()? onPinchStart;
  final void Function(double ratio)? onPinchScale;
  final void Function()? onPinchEnd;

  @override
  State<PetStage> createState() => _PetStageState();
}

class _PetStageState extends State<PetStage> {
  /// 当前按下的指针（pointerId → 局部坐标）。
  final Map<int, Offset> _pointers = {};

  /// 捏合开始时的双指距离。
  double? _pinchStartDistance;

  /// 捏合结束后、所有手指抬起前，抑制剩余手指的交互转发（防误触）。
  bool _suppressUntilAllUp = false;

  bool get _pinching => _pinchStartDistance != null;

  double _twoPointerDistance() {
    final pts = _pointers.values.toList(growable: false);
    if (pts.length < 2) return 0;
    return (pts[0] - pts[1]).distance;
  }

  void _handleDown(PointerDownEvent event) {
    _pointers[event.pointer] = event.localPosition;

    // 捏合余波未消：只跟踪，不转发。
    if (_suppressUntilAllUp) return;

    if (_pointers.length == 2) {
      // 第二指落下：进入捏合。取消窗口拖动候选，并干净地结束进行中的
      // 单指互动（抚摸会话有内部定时器，必须通过 onPointerUp 收尾）。
      widget.onDragCandidateUp?.call();
      widget.controller.onPointerUp(event.localPosition);
      _pinchStartDistance = _twoPointerDistance();
      widget.onPinchStart?.call();
      return;
    }
    if (_pointers.length > 2) return; // 三指及以上：只跟踪。

    final isSecondary = event.buttons & kSecondaryMouseButton != 0;
    widget.controller.onPointerDown(event.localPosition,
        isSecondary: isSecondary);
    // 窗口拖动仅主键触发（右键/抚摸键不拖动窗口）。
    if (!isSecondary) {
      widget.onDragCandidateDown?.call(event.position);
    }
  }

  void _handleMove(PointerMoveEvent event) {
    if (_pointers.containsKey(event.pointer)) {
      _pointers[event.pointer] = event.localPosition;
    }

    if (_pinching) {
      final start = _pinchStartDistance;
      if (start != null && start > 0) {
        final current = _twoPointerDistance();
        if (current > 0) {
          widget.onPinchScale?.call(current / start);
        }
      }
      return;
    }
    if (_suppressUntilAllUp) return;

    final isSecondary = event.buttons & kSecondaryMouseButton != 0;
    widget.controller
        .onPointerMove(event.localPosition, isSecondary: isSecondary);
    if (!isSecondary) {
      widget.onDragCandidateMove?.call(event.position);
    }
  }

  void _handleUp(PointerUpEvent event) {
    final wasPinching = _pinching;
    _pointers.remove(event.pointer);

    if (wasPinching) {
      if (_pointers.length < 2) {
        _pinchStartDistance = null;
        widget.onPinchEnd?.call();
        // 还剩一根手指按在屏幕上：它不再对应任何按下事件，
        // 直到全部抬起前不恢复交互转发。
        _suppressUntilAllUp = _pointers.isNotEmpty;
      }
      return;
    }
    if (_suppressUntilAllUp) {
      if (_pointers.isEmpty) _suppressUntilAllUp = false;
      return;
    }

    widget.onDragCandidateUp?.call();
    final isSecondary = event.buttons & kSecondaryMouseButton != 0;
    final handled = widget.controller
        .onPointerUp(event.localPosition, isSecondary: isSecondary);
    if (!handled && !isSecondary) {
      // 单击（非拖动场景简化处理）
      widget.controller.onClick(event.localPosition);
    }
  }

  void _handleCancel(PointerCancelEvent event) {
    final wasPinching = _pinching;
    _pointers.remove(event.pointer);
    if (wasPinching && _pointers.length < 2) {
      _pinchStartDistance = null;
      widget.onPinchEnd?.call();
    }
    if (_pointers.isEmpty) _suppressUntilAllUp = false;
    widget.onDragCandidateUp?.call();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return MouseRegion(
      opaque: true, // 整个区域都参与命中（视线跟随需要持续接收指针位置）
      onHover: (event) => controller.onPointerMove(event.localPosition),
      onEnter: (event) => controller.onPointerMove(event.localPosition),
      onExit: (_) => controller.onPointerLeave(),
      child: Listener(
        behavior: HitTestBehavior.opaque, // 整个区域接收指针事件（拖动/点击/捏合）
        onPointerSignal: (event) {
          if (event is PointerScrollEvent) {
            widget.onWheelZoom?.call(event.scrollDelta.dy);
          }
        },
        onPointerDown: _handleDown,
        onPointerMove: _handleMove,
        onPointerUp: _handleUp,
        onPointerCancel: _handleCancel,
        child: Stack(
          children: [
            // 镜像显示：命中区域与视线已在 Dart 侧翻转，
            // 这里翻转渲染画面使三者一致。
            ValueListenableBuilder<bool>(
              valueListenable: controller.mirrored,
              builder: (context, mirrored, child) => Transform.flip(
                flipX: mirrored,
                child: child,
              ),
              child: Live2DView(
                host: controller.host,
                pixelFormat: widget.pixelFormat,
                viewportWidth: widget.renderWidth ?? widget.viewportWidth,
                viewportHeight: widget.renderHeight ?? widget.viewportHeight,
                paused: widget.paused,
                targetFps: widget.targetFps,
              ),
            ),
            // 台词气泡
            Positioned(
              top: 8,
              left: 8,
              right: 8,
              child: ValueListenableBuilder<String?>(
                valueListenable: controller.bubbleText,
                builder: (context, text, _) {
                  if (text == null || text.isEmpty) {
                    return const SizedBox.shrink();
                  }
                  return Align(
                    alignment: Alignment.topCenter,
                    child: Container(
                      constraints:
                          BoxConstraints(maxWidth: widget.bubbleMaxWidth),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.92),
                        borderRadius: BorderRadius.circular(16),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.15),
                            blurRadius: 8,
                            offset: const Offset(0, 2),
                          ),
                        ],
                      ),
                      child: Text(
                        text,
                        style: const TextStyle(
                          fontSize: 14,
                          color: Colors.black87,
                          height: 1.4,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
