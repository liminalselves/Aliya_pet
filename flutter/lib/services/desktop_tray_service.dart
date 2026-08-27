import 'dart:io';

import 'package:tray_manager/tray_manager.dart';

import 'desktop_window_manager.dart';

/// 系统托盘菜单（仅 Windows）。
class DesktopTrayService {
  DesktopTrayService._();

  static final DesktopTrayService instance = DesktopTrayService._();

  bool _ready = false;

  /// 回调：退出应用。
  void Function()? onQuit;

  /// 回调：显示/隐藏窗口切换。
  void Function()? onToggleVisibility;

  /// 回调：切换置顶。
  void Function()? onToggleAlwaysOnTop;

  /// 回调：循环切换尺寸档位。
  void Function()? onCycleSize;

  /// 回调：位置重置到屏幕中心。
  void Function()? onResetPosition;

  /// 回调：显示关于对话框。
  void Function()? onShowAbout;

  /// 回调：打开主菜单界面。
  void Function()? onShowMainMenu;

  Future<void> initialize() async {
    if (!Platform.isWindows || _ready) return;
    await trayManager.setIcon('assets/icons/tray.ico');
    // 显式设置悬停提示：不设置时 Windows 会显示默认的应用文本（可能乱码/系统语言）。
    await trayManager.setToolTip('Aliya Pet');
    await _rebuildMenu();
    trayManager.addListener(_TrayListener(this));
    _ready = true;
  }

  Future<void> _rebuildMenu() async {
    await trayManager.setContextMenu(Menu(
      items: [
        MenuItem(key: 'menu', label: '主菜单'),
        MenuItem(key: 'show', label: '显示 / 隐藏桌宠'),
        MenuItem.separator(),
        MenuItem(key: 'cycle_size', label: '切换尺寸'),
        MenuItem(key: 'top', label: '置顶显示',
            checked: DesktopWindowManager.instance.isAlwaysOnTop),
        MenuItem(key: 'reset_pos', label: '重置位置'),
        MenuItem.separator(),
        MenuItem(key: 'about', label: '关于'),
        MenuItem(key: 'quit', label: '退出桌宠'),
      ],
    ));
  }

  /// 更新置顶菜单勾选状态。
  Future<void> updateAlwaysOnTopMenu(bool onTop) async {
    if (!_ready) return;
    await _rebuildMenu();
  }
}

class _TrayListener with TrayListener {
  _TrayListener(this._service);

  final DesktopTrayService _service;

  @override
  void onTrayIconMouseDown() {
    // 单击托盘图标：显示/隐藏窗口
    _service.onToggleVisibility?.call();
  }

  @override
  void onTrayIconRightMouseDown() {
    // 右键立即弹出托盘菜单。
    trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'menu':
        _service.onShowMainMenu?.call();
        break;
      case 'show':
        _service.onToggleVisibility?.call();
        break;
      case 'cycle_size':
        _service.onCycleSize?.call();
        break;
      case 'top':
        _service.onToggleAlwaysOnTop?.call();
        break;
      case 'reset_pos':
        _service.onResetPosition?.call();
        break;
      case 'about':
        _service.onShowAbout?.call();
        break;
      case 'quit':
        _service.onQuit?.call();
        break;
    }
  }
}
