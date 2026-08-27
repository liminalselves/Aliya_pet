import 'dart:ffi';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ffi/ffi.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'native/aliya_live2d_host.dart';

/// Live2D 渲染视图：离屏渲染 + CPU 读回 + Image 呈现。
///
/// 每帧流程：update → render → copyFramePixels → decodeImageFromPixels。
/// 像素格式：D3D11 为 BGRA 预乘 alpha，GLES 为 RGBA 直通；两者都"顶行在前"。
///
/// 性能优化：
/// - [targetFps] 默认 30，空闲时降低 CPU 读回/解码频率；
///   指针悬停交互时由上层提高到 60。
/// - 双快照缓冲复用 Dart 内存，避免每帧分配 1~2MB 像素数组。
/// - 解码队列已满时跳过渲染，避免 Native 渲染了却无法上屏。
class Live2DView extends StatefulWidget {
  const Live2DView({
    super.key,
    required this.host,
    this.pixelFormat = PixelFormat.bgra,
    this.viewportWidth = 512,
    this.viewportHeight = 768,
    this.paused = false,
    this.targetFps = 30,
  });

  final AliyaLive2DHost host;

  /// 读回像素格式（Windows: bgra；Android: rgba）。
  final PixelFormat pixelFormat;

  /// 渲染视口尺寸（物理像素，与 Native 渲染目标一致）。
  final int viewportWidth;

  final int viewportHeight;

  /// 暂停渲染：窗口/视口 resize 期间置 true，保持上一帧显示，避免中间态闪烁。
  final bool paused;

  /// 目标帧率。空闲桌面宠物建议 30，鼠标交互时建议 60。
  final int targetFps;

  @override
  State<Live2DView> createState() => _Live2DViewState();
}

enum PixelFormat { bgra, rgba }

class _Live2DViewState extends State<Live2DView>
    with SingleTickerProviderStateMixin {
  static const int _snapshotCount = 2;

  late final Ticker _ticker;
  ui.Image? _frame;
  Pointer<Uint8>? _buffer;
  Uint8List? _bufferView;
  int _bufferSize = 0;
  bool _failed = false;
  String? _error;
  final Stopwatch _clock = Stopwatch();

  /// 预分配的两个像素快照：异步解码期间不重复使用同一个数组。
  final List<Uint8List?> _snapshots =
      List<Uint8List?>.filled(_snapshotCount, null);
  final List<bool> _snapshotBusy =
      List<bool>.filled(_snapshotCount, false);

  Duration _lastFrameElapsed = Duration.zero;

  int get _w => widget.viewportWidth;
  int get _h => widget.viewportHeight;

  double get _fps {
    final fps = widget.targetFps;
    if (fps >= 60) return 60;
    if (fps <= 15) return 15;
    return fps.toDouble();
  }

  Duration get _frameInterval =>
      Duration(microseconds: (1000000 / _fps).round());

  @override
  void initState() {
    super.initState();
    _clock.start();
    // 渲染视口与 Native 同步（attachWindow 用的是默认 512x768，
    // 若配置了动态尺寸则在此校准）
    try {
      widget.host.setViewport(widget.viewportWidth, widget.viewportHeight);
    } catch (_) {}
    _ticker = createTicker(_onTick)..start();
  }

  @override
  void didUpdateWidget(Live2DView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 渲染视口尺寸变化：同步 Native 渲染目标并重建缓冲，避免 readBack 越界。
    if (widget.viewportWidth != oldWidget.viewportWidth ||
        widget.viewportHeight != oldWidget.viewportHeight) {
      _disposeBuffer();
      for (var i = 0; i < _snapshotCount; i++) {
        // 正在异步解码的旧快照由 GC 在回调结束后回收；空闲快照立即释放。
        if (!_snapshotBusy[i]) {
          _snapshots[i] = null;
        }
      }
      try {
        widget.host.setViewport(widget.viewportWidth, widget.viewportHeight);
      } catch (_) {
        // 失败时维持旧缓冲，下一帧再试
      }
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _disposeBuffer();
    _frame?.dispose();
    super.dispose();
  }

  void _disposeBuffer() {
    if (_buffer != null) {
      calloc.free(_buffer!);
      _buffer = null;
      _bufferView = null;
      _bufferSize = 0;
    }
  }

  int? _freeSnapshot() {
    for (var i = 0; i < _snapshotCount; i++) {
      if (!_snapshotBusy[i]) return i;
    }
    return null;
  }

  void _onTick(Duration elapsed) {
    if (!mounted || _failed || widget.paused) return;

    // 帧率限制：到点才执行 update/render/readback。
    if (elapsed - _lastFrameElapsed < _frameInterval) return;
    _lastFrameElapsed = elapsed;

    // 两个解码槽都在忙：本轮不渲染，避免积压解码队列和浪费 GPU 渲染。
    final index = _freeSnapshot();
    if (index == null) return;

    final host = widget.host;
    try {
      var dt = _clock.elapsedMicroseconds / 1e6;
      _clock.reset();
      // 掉帧/恢复渲染时避免 delta 过大导致动作瞬移。
      if (dt > 0.1) dt = 0.1;

      host.update(dt);
      host.render();
      _readBack(index);
    } catch (e) {
      _failed = true;
      _error = e.toString();
      if (mounted) setState(() {});
    }
  }

  void _readBack(int index) {
    final host = widget.host;
    final stride = _w * 4;
    final needed = stride * _h;

    if (_buffer == null || _bufferSize < needed) {
      _disposeBuffer();
      _buffer = calloc<Uint8>(needed);
      _bufferView = _buffer!.asTypedList(needed);
      _bufferSize = needed;
    }

    host.copyFramePixels(_buffer!, stride);

    // 复用预分配的 Dart 快照：copyFramePixels 后立即复制出来，
    // FFI buffer 可以马上复用，异步解码期间也不怕数据被覆盖。
    var snapshot = _snapshots[index];
    if (snapshot == null || snapshot.length != needed) {
      snapshot = Uint8List(needed);
      _snapshots[index] = snapshot;
    }
    snapshot.setRange(0, needed, _bufferView!);
    _snapshotBusy[index] = true;

    final format = widget.pixelFormat == PixelFormat.bgra
        ? ui.PixelFormat.bgra8888
        : ui.PixelFormat.rgba8888;
    ui.decodeImageFromPixels(snapshot, _w, _h, format, (image) {
      _snapshotBusy[index] = false;
      if (!mounted) {
        image.dispose();
        return;
      }
      _frame?.dispose();
      _frame = image;
      setState(() {});
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            'Live2D 渲染失败\n'
            '$_error',
            style: const TextStyle(color: Colors.red, fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    if (_frame == null) {
      return const SizedBox.shrink();
    }
    return RawImage(
      image: _frame!,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.low,
    );
  }
}
