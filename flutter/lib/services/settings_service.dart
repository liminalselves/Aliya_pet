import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'scale_policy.dart';

/// 桌面设置持久化（位置/置顶/贴边/缩放/动作开关）+ Windows 系统自启（注册表 Run 键）。
class SettingsService {
  SettingsService._();

  static final SettingsService instance = SettingsService._();

  static const _runKey =
      r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';

  // 键名
  static const _kX = 'pos_x';
  static const _kY = 'pos_y';
  static const _kTop = 'always_on_top';
  static const _kSnap = 'snap_edges';
  static const _kScale = 'scale';
  static const _kAutoActions = 'auto_actions';

  static const _kMirror = 'mirror';

  // 运行时状态（load 后填充）
  double? windowX;
  double? windowY;
  bool alwaysOnTop = false;
  bool snapEdges = true;
  double scale = 1.0;
  bool autoActions = true;
  bool mirror = false;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    windowX = prefs.getDouble(_kX);
    windowY = prefs.getDouble(_kY);
    alwaysOnTop = prefs.getBool(_kTop) ?? false;
    snapEdges = prefs.getBool(_kSnap) ?? true;
    // 防御性消毒：损坏/越界的持久化值（NaN、0、负数、超大）回收到绝对范围内。
    scale = ScalePolicy.clampAbsolute(prefs.getDouble(_kScale) ?? 1.0);
    autoActions = prefs.getBool(_kAutoActions) ?? true;
    mirror = prefs.getBool(_kMirror) ?? false;
  }

  Future<void> savePosition(double x, double y) async {
    windowX = x;
    windowY = y;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_kX, x);
    await prefs.setDouble(_kY, y);
  }

  Future<void> saveAlwaysOnTop(bool on) async {
    alwaysOnTop = on;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kTop, on);
  }

  Future<void> saveSnapEdges(bool on) async {
    snapEdges = on;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kSnap, on);
  }

  Future<void> saveScale(double v) async {
    final sanitized = ScalePolicy.clampAbsolute(v);
    scale = sanitized;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_kScale, sanitized);
  }

  Future<void> saveAutoActions(bool on) async {
    autoActions = on;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kAutoActions, on);
  }

  Future<void> saveMirror(bool on) async {
    mirror = on;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kMirror, on);
  }

  // ---------- 系统自启（注册表 Run 键，reg.exe 实现） ----------

  Future<void> setAutoStart(bool enabled) async {
    if (!Platform.isWindows) return;
    if (enabled) {
      final exe = '"${Platform.resolvedExecutable}"';
      await Process.run('reg', [
        'add', _runKey, '/v', 'AliyaPet', '/t', 'REG_SZ', '/d', exe, '/f',
      ]);
    } else {
      await Process.run('reg', ['delete', _runKey, '/v', 'AliyaPet', '/f']);
    }
  }

  Future<bool> autoStartEnabled() async {
    if (!Platform.isWindows) return false;
    final r = await Process.run('reg', ['query', _runKey, '/v', 'AliyaPet']);
    return r.exitCode == 0;
  }
}
