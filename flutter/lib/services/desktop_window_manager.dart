import 'dart:io';
import 'dart:ui' show Offset, Size;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show Colors;
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

/// Windows 桌面窗口管理：透明无边框 + 置顶 + 屏幕吸附 + 窗口拖动。
///
/// 对应原 WPF 版窗口能力（透明/置顶/贴边吸附/拖动），
/// 仅 Windows 平台启用；Android/其他平台为 no-op。
class DesktopWindowManager {
  DesktopWindowManager._();

  static final DesktopWindowManager instance = DesktopWindowManager._();

  static const double _screenEdgeSnapThreshold = 80.0; // 吸附阈值（物理像素），太小用户不易感知贴边

  /// 窗口是否初始化完成。
  bool _ready = false;

  /// 窗口尺寸（逻辑像素）。
  double windowWidth = 512;
  double windowHeight = 768;

  /// 是否启用屏幕边缘吸附。
  bool snapToScreenEdges = true;

  /// 是否置顶。
  bool get isAlwaysOnTop => _alwaysOnTop;
  bool _alwaysOnTop = false;

  /// 屏幕吸附回调（上层 UI 提示用）。
  ValueChanged<String>? onSnapChanged;

  /// 初始化窗口（在 runApp 前调用）。
  Future<void> initialize({double width = 512, double height = 768}) async {
    if (!Platform.isWindows || _ready) return;
    windowWidth = width;
    windowHeight = height;

    await windowManager.ensureInitialized();
    final options = WindowOptions(
      size: Size(width, height),
      center: true,
      backgroundColor: Colors.transparent,
      skipTaskbar: true,
      titleBarStyle: TitleBarStyle.hidden,
      alwaysOnTop: true,
    );
    await windowManager.waitUntilReadyToShow(options, () async {
      await windowManager.setSkipTaskbar(true);
      await windowManager.setAlwaysOnTop(true);
      await windowManager.setPreventClose(true);
      await windowManager.setResizable(false);
      // 不在这里 show：等 runApp 后 Flutter 第一帧画出启动/加载 UI 再显示，
      // 避免启动瞬间出现原生窗口白底或空白内容。
    });
    _alwaysOnTop = true;
    _ready = true;
  }

  /// 显示主窗口（由 main 在首帧渲染完成后调用）。
  Future<void> show() async {
    if (!_ready) return;
    try {
      await windowManager.show();
    } catch (_) {
      // 窗口可能已被用户关闭，忽略。
    }
  }

  /// 设置置顶。
  Future<void> setAlwaysOnTop(bool onTop) async {
    if (!_ready) return;
    await windowManager.setAlwaysOnTop(onTop);
    _alwaysOnTop = onTop;
  }

  /// 设置透明窗口（默认开启）。
  Future<void> setTransparent(bool transparent) async {
    if (!_ready) return;
    if (transparent) {
      await windowManager.setOpacity(1.0);
    }
  }

  /// 开始窗口拖动（由 UI 拖动区域调用）。
  Future<void> startDragging() async {
    if (!_ready) return;
    await windowManager.startDragging();
  }

  /// 窗口拖动结束后调用：屏幕边缘吸附。
  /// [pointerGlobalDx]/[pointerGlobalDy] 为指针全局坐标（可选，用于偏移补偿）。
  Future<void> onDragEnd({double? pointerGlobalDx, double? pointerGlobalDy}) async {
    if (!_ready || !snapToScreenEdges) return;
    await _snapToScreenEdge();
  }

  Future<void> _snapToScreenEdge() async {
    final pos = await windowManager.getPosition();
    final size = await windowManager.getSize();
    final display = await screenRetriever.getPrimaryDisplay();
    final visiblePos = display.visiblePosition;
    final visibleSize = display.visibleSize;
    if (visiblePos == null || visibleSize == null) return;

    // 工作区 = 可见区域（已扣除任务栏）
    final workLeft = visiblePos.dx;
    final workTop = visiblePos.dy;
    final workRight = visiblePos.dx + visibleSize.width;
    final workBottom = visiblePos.dy + visibleSize.height;

    // 当前窗口在屏幕工作区内的偏移
    final winLeft = pos.dx - workLeft;
    final winTop = pos.dy - workTop;
    final winRight = workRight - (pos.dx + size.width);
    final winBottom = workBottom - (pos.dy + size.height);

    double newX = pos.dx;
    double newY = pos.dy;
    String? snapped;

    // 左边缘
    if (winLeft <= _screenEdgeSnapThreshold &&
        winLeft >= -_screenEdgeSnapThreshold * 2) {
      newX = workLeft;
      snapped = 'left';
    }
    // 右边缘
    if (winRight <= _screenEdgeSnapThreshold &&
        winRight >= -_screenEdgeSnapThreshold * 2) {
      newX = workRight - size.width;
      snapped = 'right';
    }
    // 上边缘
    if (winTop <= _screenEdgeSnapThreshold &&
        winTop >= -_screenEdgeSnapThreshold * 2) {
      newY = workTop;
      snapped = snapped ?? 'top';
    }
    // 下边缘（桌面宠物可吸附底部）
    if (winBottom <= _screenEdgeSnapThreshold &&
        winBottom >= -_screenEdgeSnapThreshold * 2) {
      newY = workBottom - size.height;
      snapped = snapped ?? 'bottom';
    }

    if (snapped != null) {
      await windowManager.setPosition(Offset(newX, newY));
      onSnapChanged?.call(snapped);
    }
  }

  /// 当前窗口位置。
  Future<Offset> getPosition() async {
    if (!_ready) return Offset.zero;
    final pos = await windowManager.getPosition();
    return Offset(pos.dx, pos.dy);
  }

  /// 移动窗口。
  Future<void> moveTo(double x, double y) async {
    if (!_ready) return;
    await windowManager.setPosition(Offset(x, y));
  }

  /// 退出应用（托盘菜单调用）。
  Future<void> quit() async {
    if (!_ready) {
      exit(0);
    }
    await windowManager.setPreventClose(false);
    await windowManager.destroy();
  }
}
