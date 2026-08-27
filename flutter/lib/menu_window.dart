import 'dart:async';

import 'package:desktop_multi_window/desktop_multi_window.dart';
import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'main_menu.dart';
import 'services/settings_service.dart';

/// 独立菜单窗口（Windows）。
///
/// 与桌宠主窗口完全分离：任务栏可见、尺寸固定，不随桌宠缩放变化。
class MenuWindowApp extends StatefulWidget {
  const MenuWindowApp({super.key});

  @override
  State<MenuWindowApp> createState() => _MenuWindowAppState();
}

class _MenuWindowAppState extends State<MenuWindowApp> {
  static const _channel = WindowMethodChannel(
    'top.liminalselves.aliyapet/menu',
    mode: ChannelMode.unidirectional,
  );

  bool _loaded = false;
  bool _overlayRunning = false;

  // 从主窗口拉取的当前 scale 与设备可用范围（滑块初始值/边界）。
  double? _scale;
  double? _scaleMin;
  double? _scaleMax;

  @override
  void initState() {
    super.initState();
    _loadState();
  }

  Future<void> _loadState() async {
    try {
      final state =
          await _channel.invokeMethod<Map<dynamic, dynamic>>('getState');
      if (!mounted) return;

      final s = SettingsService.instance;
      s.autoActions = state?['autoActions'] as bool? ?? true;
      s.alwaysOnTop = state?['alwaysOnTop'] as bool? ?? false;
      s.snapEdges = state?['snapEdges'] as bool? ?? true;
      s.mirror = state?['mirror'] as bool? ?? false;
      _overlayRunning = state?['overlayRunning'] as bool? ?? false;
      _scale = (state?['scale'] as num?)?.toDouble();
      _scaleMin = (state?['scaleMin'] as num?)?.toDouble();
      _scaleMax = (state?['scaleMax'] as num?)?.toDouble();
      if (_scale != null) s.scale = _scale!;

      setState(() => _loaded = true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _loaded = true);
    }
  }

  Future<void> _close() async {
    // 关闭按钮只隐藏菜单窗口，不销毁第二个 Flutter 引擎。
    // 下次打开时直接 show，避免每次重新创建窗口/引擎导致的明显卡顿。
    try {
      await windowManager.hide();
    } catch (_) {
      // L26 修复：回退分支嵌套 try/catch，避免 setPreventClose 抛错上抛
      try {
        await windowManager.setPreventClose(false);
        await windowManager.close();
      } catch (_) {
        // 回退也失败则静默放弃
      }
    }
  }

  Future<void> _invoke(String method, [Map<String, dynamic>? args]) async {
    try {
      await _channel.invokeMethod(method, args);
    } catch (_) {
      // 主窗口暂时不可用，静默忽略。
    }
  }

  /// setScale 需要带回返回值（夹紧后的实际 scale），单独走带返回值的通道调用。
  Future<double?> _invokeSetScale(double v) async {
    try {
      final r = await _channel
          .invokeMethod<Map<dynamic, dynamic>>('setScale', {'value': v});
      return (r?['scale'] as num?)?.toDouble();
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: const Color(0xFF000000),
        body: _loaded
            ? MainMenuPanel(
                fullWindow: true,
                controller: null,
                callbacks: MainMenuCallbacks(
                  onClose: _close,
                  onSetScale: _invokeSetScale,
                  onSetScaleLive: (v) => _invoke('setScaleLive', {'value': v}),
                  onResetPosition: () => _invoke('resetPosition'),
                  onToggleAlwaysOnTop: (v) =>
                      _invoke('setAlwaysOnTop', {'value': v}),
                  onToggleSnapEdges: (v) =>
                      _invoke('setSnapEdges', {'value': v}),
                  onToggleAutoStart: (v) =>
                      _invoke('setAutoStart', {'value': v}),
                  onToggleAutoActions: (v) =>
                      _invoke('setAutoActions', {'value': v}),
                  onToggleMirror: (v) => _invoke('setMirror', {'value': v}),
                  onToggleOverlay: () => _invoke('toggleOverlay'),
                  onShowAbout: () => _invoke('showAbout'),
                  onOpenRepository: () => _invoke('openRepository'),
                  onPlayAction: (name) => _invoke('playAction', {'name': name}),
                  onRandomActionName: () async {
                    try {
                      return await _channel.invokeMethod<String>(
                            'randomActionName',
                          ) ??
                          'idle';
                    } catch (_) {
                      return 'idle';
                    }
                  },
                  overlayRunning: _overlayRunning,
                  initialScale: _scale,
                  scaleMin: _scaleMin,
                  scaleMax: _scaleMax,
                ),
              )
            : const Center(
                child: CircularProgressIndicator(color: Color(0xFF0A84FF)),
              ),
      ),
    );
  }
}
