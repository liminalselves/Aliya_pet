import 'dart:io';

import 'package:flutter/material.dart';

import 'pet_controller.dart';
import 'services/scale_policy.dart';
import 'services/settings_service.dart';

/// 动作定义（name / 中文名 / 图标 / 说明）。
const _actions = <({String name, String label, IconData icon, String desc})>[
  (name: 'idle', label: '待机', icon: Icons.accessibility_new, desc: '回到待机姿态'),
  (name: 'wave', label: '挥手', icon: Icons.waving_hand, desc: '向你挥手打招呼'),
  (name: 'nod', label: '点头', icon: Icons.thumb_up, desc: '点头回应你'),
  (name: 'stretch', label: '伸懒腰', icon: Icons.self_improvement, desc: '伸个懒腰放松一下'),
  (name: 'yawn', label: '打哈欠', icon: Icons.nightlight_outlined, desc: '打了个哈欠，有点困了'),
  (name: 'shake', label: '摇头', icon: Icons.do_not_disturb, desc: '摇头表示不同意'),
  (name: 'sway', label: '摇摆', icon: Icons.toys, desc: '开心地左右摇摆'),
  (name: 'angry', label: '生气', icon: Icons.sentiment_very_dissatisfied, desc: '生气地鼓起脸颊'),
  (name: 'doubt', label: '疑惑', icon: Icons.help_outline, desc: '歪头露出疑惑的表情'),
  (name: 'click', label: '点击', icon: Icons.touch_app, desc: '被点击时的反应'),
  (name: 'drag', label: '拖动', icon: Icons.drag_indicator, desc: '被拖动时的反应'),
  (name: 'fall', label: '摔倒', icon: Icons.trending_down, desc: '不小心摔倒'),
  (name: 'land', label: '落地', icon: Icons.landscape_outlined, desc: '落地站稳'),
  (name: 'edge_idle', label: '贴边待机', icon: Icons.vertical_align_bottom, desc: '靠在屏幕边缘待机'),
  (name: 'walk_left', label: '左走', icon: Icons.arrow_back, desc: '向左迈步'),
  (name: 'walk_right', label: '右走', icon: Icons.arrow_forward, desc: '向右迈步'),
];

/// 标签页定义（单一数据源，TabController 长度由此派生）。
const _menuTabs = <({String label, IconData icon})>[
  (label: '动作', icon: Icons.play_circle_outline),
  (label: '互动', icon: Icons.touch_app),
  (label: '外观', icon: Icons.palette_outlined),
  (label: '设置', icon: Icons.settings_outlined),
  (label: '关于', icon: Icons.info_outline),
];

/// 主菜单面板（Windows / Android 通用）。
class MainMenuPanel extends StatefulWidget {
  const MainMenuPanel({
    super.key,
    this.controller,
    required this.callbacks,
    this.fullWindow = false,
  });

  final PetController? controller;
  final MainMenuCallbacks callbacks;
  final bool fullWindow;

  @override
  State<MainMenuPanel> createState() => _MainMenuPanelState();
}

/// 面板回调（由宿主页面实现，双端共用）。
class MainMenuCallbacks {
  const MainMenuCallbacks({
    this.onClose,
    this.onSetScale,
    this.onSetScaleLive,
    this.onResetPosition,
    this.onToggleAlwaysOnTop,
    this.onToggleSnapEdges,
    this.onToggleAutoStart,
    this.onToggleAutoActions,
    this.onToggleMirror,
    this.onToggleOverlay,
    this.onShowAbout,
    this.onOpenRepository,
    this.onPlayAction,
    this.onRandomActionName,
    this.overlayRunning = false,
    this.initialScale,
    this.scaleMin,
    this.scaleMax,
  });

  final void Function()? onClose;
  final Future<double?> Function(double scale)? onSetScale;
  final void Function(double scale)? onSetScaleLive;
  final void Function()? onResetPosition;
  final Future<void> Function(bool on)? onToggleAlwaysOnTop;
  final Future<void> Function(bool on)? onToggleSnapEdges;
  final Future<void> Function(bool on)? onToggleAutoStart;
  final Future<void> Function(bool on)? onToggleAutoActions;
  final Future<void> Function(bool on)? onToggleMirror;
  final void Function()? onToggleOverlay;
  final void Function()? onShowAbout;
  final void Function()? onOpenRepository;
  final void Function(String name)? onPlayAction;
  final Future<String> Function()? onRandomActionName;
  final bool overlayRunning;

  /// 打开菜单时的当前 scale（独立窗口场景由宿主经 getState 拉取后传入）。
  final double? initialScale;

  /// 当前设备可用缩放范围（独立窗口场景由宿主经 getState 拉取后传入）。
  final double? scaleMin;
  final double? scaleMax;
}

class _MainMenuPanelState extends State<MainMenuPanel>
    with SingleTickerProviderStateMixin {
  // M22 修复：TabController 长度由 _menuTabs 派生，避免三处硬编码不一致
  late final TabController _tab = TabController(length: _menuTabs.length, vsync: this);

  bool _autoActions = true;
  bool _alwaysOnTop = false;
  bool _snapEdges = true;
  bool _autoStart = false;
  bool _mirror = false;

  // 角色大小滑动条状态
  late double _scale;

  // slider 实时缩放节流：拖动期间以约 30Hz 同步，避免高频通道调用卡顿。
  DateTime _lastLiveApply = DateTime.fromMillisecondsSinceEpoch(0);

  // 缩放绝对范围统一由 ScalePolicy 提供；
  // 菜单宿主经 callbacks.scaleMin/scaleMax 传入设备动态范围后会被覆盖。
  double get _effectiveMin =>
      widget.callbacks.scaleMin ?? ScalePolicy.absoluteMin;
  double get _effectiveMax =>
      widget.callbacks.scaleMax ?? ScalePolicy.absoluteMax;

  // 现代简约配色：纯黑背景 + 单一强调色
  static const Color _bg = Color(0xFF000000);
  static const Color _surface = Color(0xFF1A1A1A);
  static const Color _border = Color(0xFF2A2A2A);
  static const Color _text = Color(0xFFFFFFFF);
  static const Color _textSec = Color(0xFF999999);
  static const Color _textTer = Color(0xFF666666);
  static const Color _accent = Color(0xFF0A84FF); // iOS 系统蓝

  @override
  void initState() {
    super.initState();
    final s = SettingsService.instance;
    _autoActions = s.autoActions;
    _alwaysOnTop = s.alwaysOnTop;
    _snapEdges = s.snapEdges;
    _mirror = s.mirror;
    // 独立菜单窗口场景下，本地 SettingsService 未加载过主窗口设置，
    // 优先使用宿主经 getState 传入的当前 scale 与设备范围。
    final baseScale = widget.callbacks.initialScale ?? s.scale;
    _scale = baseScale.clamp(_effectiveMin, _effectiveMax).toDouble();
    if (Platform.isWindows) {
      s.autoStartEnabled().then((v) {
        if (mounted) setState(() => _autoStart = v);
      });
    }
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  void _playAction(String name) {
    final controller = widget.controller;
    if (controller != null) {
      controller.behavior.playAction(name);
    } else {
      widget.callbacks.onPlayAction?.call(name);
    }
    // Windows 独立菜单窗口不自动关闭（用户可连续点击多个动作）；
    // Android 悬浮菜单覆盖在桌宠上，点击后关闭以免遮挡。
    if (!widget.fullWindow) {
      widget.callbacks.onClose?.call();
    }
  }

  Future<void> _playRandom() async {
    final controller = widget.controller;
    String name;
    if (controller != null) {
      name = controller.behavior.randomActionName();
    } else {
      name = await widget.callbacks.onRandomActionName?.call() ?? 'idle';
    }
    // L28 修复：await 后检查 mounted
    if (!mounted) return;
    _playAction(name);
  }

  @override
  Widget build(BuildContext context) {
    final isWindows = Platform.isWindows;

    if (widget.fullWindow) {
      return Material(
        color: _bg,
        child: SafeArea(
          child: _buildPanelBody(isWindows),
        ),
      );
    }

    // 悬浮菜单：半透明遮罩 + 简约卡片
    return Material(
      color: Colors.black.withValues(alpha: 0.6),
      child: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: 420,
              maxHeight: 680,
            ),
            child: Container(
              margin: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: _bg,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: _border, width: 1),
              ),
              clipBehavior: Clip.antiAlias,
              child: _buildPanelBody(isWindows),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPanelBody(bool isWindows) {
    return Column(
      mainAxisSize: MainAxisSize.max,
      children: [
        _buildHeader(),
        _buildTabBar(),
        Expanded(
          child: TabBarView(
            controller: _tab,
            children: [
              _buildActionsTab(),
              _buildInteractionTab(isWindows),
              _buildAppearanceTab(),
              _buildSettingsTab(isWindows),
              _buildAboutTab(),
            ],
          ),
        ),
      ],
    );
  }

  // ========== 顶部栏 ==========

  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: _border, width: 1)),
      ),
      child: Row(
        children: [
          const Icon(Icons.pets, color: _text, size: 24),
          const SizedBox(width: 12),
          const Expanded(
            child: Text(
              'Aliya Pet',
              style: TextStyle(
                color: _text,
                fontSize: 18,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.3,
              ),
            ),
          ),
          if (!widget.fullWindow)
            IconButton(
              onPressed: widget.callbacks.onClose,
              icon: const Icon(Icons.close, color: _textSec, size: 20),
              style: IconButton.styleFrom(
                backgroundColor: Colors.transparent,
                shape: const CircleBorder(),
              ),
            ),
        ],
      ),
    );
  }

  // ========== 标签栏 ==========

  Widget _buildTabBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Container(
        height: 48,
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: TabBar(
          controller: _tab,
          indicator: BoxDecoration(
            color: _accent,
            borderRadius: BorderRadius.circular(10),
          ),
          indicatorSize: TabBarIndicatorSize.tab,
          dividerHeight: 0,
          labelColor: Colors.white,
          unselectedLabelColor: _textSec,
          labelStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          unselectedLabelStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
          padding: const EdgeInsets.all(2),
          tabs: [
            for (final t in _menuTabs)
              Tab(
                height: 44,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(t.icon, size: 18),
                    const SizedBox(height: 2),
                    Text(t.label, style: const TextStyle(fontSize: 10)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  // ========== 动作页 ==========

  Widget _buildActionsTab() {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        // 随机动作卡片
        _buildRandomCard(),
        const SizedBox(height: 20),
        
        const Text(
          '表演动作',
          style: TextStyle(
            color: _text,
            fontSize: 16,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.2,
          ),
        ),
        const SizedBox(height: 12),
        
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 4,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 0.9,
          ),
          itemCount: _actions.length,
          itemBuilder: (context, i) {
            final a = _actions[i];
            return _buildActionButton(
              label: a.label,
              icon: a.icon,
              onTap: () => _playAction(a.name),
            );
          },
        ),
      ],
    );
  }

  Widget _buildRandomCard() {
    return Material(
      color: _accent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: _playRandom,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.shuffle, color: Colors.white, size: 22),
              ),
              const SizedBox(width: 14),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '随机表演',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    SizedBox(height: 2),
                    Text(
                      '让角色表演一个随机动作',
                      style: TextStyle(
                        color: Colors.white70,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.arrow_forward_ios, color: Colors.white70, size: 16),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildActionButton({
    required String label,
    required IconData icon,
    required VoidCallback onTap,
  }) {
    return Material(
      color: _surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: _text, size: 26),
            const SizedBox(height: 6),
            Text(
              label,
              style: const TextStyle(
                color: _textSec,
                fontSize: 11,
                fontWeight: FontWeight.w500,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  // ========== 互动页 ==========

  Widget _buildInteractionTab(bool isWindows) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _buildSwitch(
          icon: Icons.auto_awesome,
          title: '自动随机动作',
          subtitle: '角色每隔一段时间自己表演动作',
          value: _autoActions,
          onChanged: (v) async {
            setState(() => _autoActions = v);
            final controller = widget.controller;
            if (controller != null) {
              controller.behavior.autoActions = v;
            } else {
              await widget.callbacks.onToggleAutoActions?.call(v);
            }
            await SettingsService.instance.saveAutoActions(v);
          },
        ),
        const SizedBox(height: 20),
        _buildInfoBox(
          icon: Icons.lightbulb_outline,
          text: isWindows
              ? '在角色头部区域按住右键反复抚摸可以触发摸头互动；快速左右拖动会触发拖动反应。'
              : '在角色头部区域反复抚摸可以触发摸头互动；快速左右拖动会触发拖动反应。',
        ),
      ],
    );
  }

  // ========== 外观页 ==========

  Widget _buildAppearanceTab() {
    final isWindows = Platform.isWindows;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _buildScaleSlider(),
        const SizedBox(height: 12),
        _buildSwitch(
          icon: Icons.flip,
          title: '镜像显示',
          subtitle: '左右翻转角色',
          value: _mirror,
          onChanged: (v) async {
            setState(() => _mirror = v);
            final controller = widget.controller;
            if (controller != null) {
              controller.setMirrored(v);
            } else {
              await widget.callbacks.onToggleMirror?.call(v);
            }
            await SettingsService.instance.saveMirror(v);
          },
        ),
        if (isWindows) ...[
          const SizedBox(height: 12),
          _buildActionTile(
            icon: Icons.center_focus_strong,
            title: '位置重置',
            subtitle: '把宠物移回主屏幕中央',
            trailing: _buildButton(
              text: '重置',
              onTap: widget.callbacks.onResetPosition,
            ),
          ),
        ],
        const SizedBox(height: 20),
        _buildInfoBox(
          icon: Icons.lightbulb_outline,
          text: isWindows
              ? '鼠标滚轮或双指捏合也可以缩放角色；在角色身上按住并拖动即可移动窗口。'
              : '双指捏合也可以缩放角色；悬浮窗模式下按住拖动即可移动位置。',
        ),
      ],
    );
  }

  /// 拖动过程中实时调整大小（节流 ~30Hz），不等松手。
  ///
  /// 双端统一走宿主的实时路径（与滚轮/捏合同一管线：夹紧 + 内存同步），
  /// 不直接触碰 native —— 否则 Android 会绕过设备范围夹紧与设置同步。
  void _applyScaleLive(double v) {
    final now = DateTime.now();
    if (now.difference(_lastLiveApply).inMilliseconds < 33) return;
    _lastLiveApply = now;
    widget.callbacks.onSetScaleLive?.call(v);
  }

  /// 松手后做最终应用 + 持久化（宿主内部按设备范围 clamp，
  /// 返回夹紧后的实际 scale，同步滑块位置，避免停在设备不支持的值）。
  Future<void> _applyScaleFinal(double v) async {
    final actual = await widget.callbacks.onSetScale?.call(v);
    if (actual != null && mounted && (actual - _scale).abs() > 0.001) {
      setState(() => _scale = actual);
    }
  }

  /// 步进微调（±按钮）：与滚轮同倍率，按一次提交一次。
  void _stepScale(int direction) {
    final v = direction > 0
        ? _scale * ScalePolicy.stepFactor
        : _scale / ScalePolicy.stepFactor;
    final clamped =
        ScalePolicy.clampToRange(v, (min: _effectiveMin, max: _effectiveMax));
    if ((clamped - _scale).abs() < 0.0005) return;
    setState(() => _scale = clamped);
    _applyScaleFinal(clamped);
  }

  Widget _buildScaleSlider() {
    final min = _effectiveMin;
    final max = _effectiveMax;
    // 范围无效（极小屏/初始化失败）时退化为固定值滑块，避免 Slider 断言。
    final usable = max - min > 0.001;
    if (!usable) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(14),
        ),
        child: const Row(
          children: [
            Icon(Icons.aspect_ratio, color: _text, size: 22),
            SizedBox(width: 14),
            Expanded(
              child: Text(
                '角色大小（当前屏幕不支持调整）',
                style: TextStyle(
                  color: _text,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      );
    }
    final percent = (_scale * 100).round();
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.aspect_ratio, color: _text, size: 22),
              const SizedBox(width: 14),
              const Expanded(
                child: Text(
                  '角色大小',
                  style: TextStyle(
                    color: _text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              // 步进微调：与滚轮同倍率（×/÷ 1.08），适合精调。
              _buildStepButton(Icons.remove, () => _stepScale(-1)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Text(
                  '$percent%',
                  style: const TextStyle(
                    color: _accent,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _buildStepButton(Icons.add, () => _stepScale(1)),
            ],
          ),
          const SizedBox(height: 4),
          SliderTheme(
            data: SliderThemeData(
              activeTrackColor: _accent,
              inactiveTrackColor: _border,
              thumbColor: _accent,
              overlayColor: _accent.withValues(alpha: 0.2),
              trackHeight: 4,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
            ),
            child: Slider(
              value: _scale.clamp(min, max),
              min: min,
              max: max,
              onChanged: (v) {
                setState(() => _scale = v);
                // 拖动过程中实时调整大小（节流 ~30Hz），不等到松手。
                _applyScaleLive(v);
              },
              onChangeEnd: (v) async {
                // 松手后做最终应用 + 持久化（含设备范围 clamp）。
                await _applyScaleFinal(v);
              },
            ),
          ),
          const SizedBox(height: 8),
          // 快捷档位：基础档夹紧到设备范围，重复档位自动隐藏。
          _buildPresetRow(min, max),
        ],
      ),
    );
  }

  Widget _buildStepButton(IconData icon, VoidCallback onTap) {
    return Material(
      color: _border,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          width: 28,
          height: 28,
          child: Icon(icon, color: _text, size: 16),
        ),
      ),
    );
  }

  /// 快捷档位行（小/标准/大）：档位值夹紧到设备范围；
  /// 夹紧后与前一档重复（范围过窄）时省略该档。
  Widget _buildPresetRow(double min, double max) {
    const candidates = <(String, double)>[
      ('小', 0.5),
      ('标准', 1.0),
      ('大', 2.0),
    ];
    final presets = <(String, double)>[];
    for (final (label, base) in candidates) {
      final v = base.clamp(min, max).toDouble();
      if (presets.any((p) => ScalePolicy.sameValue(p.$2, v))) continue;
      presets.add((label, v));
    }
    if (presets.length < 2) return const SizedBox.shrink();

    return Row(
      children: [
        for (var i = 0; i < presets.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Expanded(child: _buildPresetChip(presets[i].$1, presets[i].$2)),
        ],
      ],
    );
  }

  Widget _buildPresetChip(String label, double value) {
    final selected = ScalePolicy.sameValue(_scale, value);
    return Material(
      color: selected ? _accent : _bg,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: () {
          setState(() => _scale = value);
          _applyScaleFinal(value);
        },
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: selected ? _accent : _border, width: 1),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: selected ? Colors.white : _textSec,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }

  // ========== 设置页 ==========

  Widget _buildSettingsTab(bool isWindows) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (isWindows) ...[
          _buildSwitch(
            icon: Icons.push_pin_outlined,
            title: '置顶显示',
            subtitle: '让宠物始终显示在其他窗口之上',
            value: _alwaysOnTop,
            onChanged: (v) async {
              setState(() => _alwaysOnTop = v);
              await widget.callbacks.onToggleAlwaysOnTop?.call(v);
            },
          ),
          const SizedBox(height: 12),
          _buildSwitch(
            icon: Icons.align_horizontal_center,
            title: '屏幕贴边',
            subtitle: '拖动后自动吸附屏幕边缘',
            value: _snapEdges,
            onChanged: (v) async {
              setState(() => _snapEdges = v);
              await widget.callbacks.onToggleSnapEdges?.call(v);
            },
          ),
          const SizedBox(height: 12),
          _buildSwitch(
            icon: Icons.power_settings_new,
            title: '开机自启',
            subtitle: 'Windows 登录后自动启动',
            value: _autoStart,
            onChanged: (v) async {
              setState(() => _autoStart = v);
              await widget.callbacks.onToggleAutoStart?.call(v);
            },
          ),
        ] else ...[
          // Android：置顶/贴边/自启对应用内窗口无意义（无效开关），
          // 设置页只保留真实生效的悬浮窗控制。
          _buildActionTile(
            icon: Icons.smartphone,
            title: '桌面悬浮窗',
            subtitle: widget.callbacks.overlayRunning
                ? '悬浮窗正在运行'
                : '把宠物挂到所有应用上方',
            trailing: _buildButton(
              text: widget.callbacks.overlayRunning ? '关闭' : '开启',
              onTap: widget.callbacks.onToggleOverlay,
            ),
          ),
          const SizedBox(height: 20),
          _buildInfoBox(
            icon: Icons.lightbulb_outline,
            text: '悬浮窗会把宠物显示在其他应用上方；双指捏合可调整大小，按住拖动可移动位置，点右上角 × 关闭。',
          ),
        ],
      ],
    );
  }

  // ========== 关于页 ==========

  Widget _buildAboutTab() {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const SizedBox(height: 20),
        const Center(
          child: Icon(Icons.pets, color: _text, size: 60),
        ),
        const SizedBox(height: 16),
        const Center(
          child: Text(
            'Aliya Pet',
            style: TextStyle(
              color: _text,
              fontSize: 24,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.5,
            ),
          ),
        ),
        const SizedBox(height: 8),
        const Center(
          child: Text(
            'Flutter + Live2D Cubism',
            style: TextStyle(color: _textSec, fontSize: 14),
          ),
        ),
        const SizedBox(height: 4),
        const Center(
          child: Text(
            '版本 2.0.0',
            style: TextStyle(color: _textTer, fontSize: 12),
          ),
        ),
        const SizedBox(height: 32),
        _buildButton(
          text: '项目仓库',
          // 双端统一走宿主回调（Windows explorer / Android 原生 Intent）。
          onTap: () => widget.callbacks.onOpenRepository?.call(),
          fullWidth: true,
        ),
        const SizedBox(height: 20),
        const Center(
          child: Text(
            '本程序为二创作品，人物原创为《彼方的她》',
            style: TextStyle(color: _textTer, fontSize: 11),
          ),
        ),
        const SizedBox(height: 4),
        const Center(
          child: Text(
            '角色形象版权归原作者所有',
            style: TextStyle(color: _textTer, fontSize: 11),
          ),
        ),
      ],
    );
  }

  // ========== 通用组件 ==========

  Widget _buildSwitch({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(icon, color: _text, size: 22),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: _textSec,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Switch(
            value: value,
            onChanged: onChanged,
            activeThumbColor: _accent,
          ),
        ],
      ),
    );
  }

  Widget _buildActionTile({
    required IconData icon,
    required String title,
    required String subtitle,
    required Widget trailing,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(icon, color: _text, size: 22),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: _text,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: _textSec,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          trailing,
        ],
      ),
    );
  }

  Widget _buildButton({
    required String text,
    VoidCallback? onTap,
    bool fullWidth = false,
  }) {
    final button = Material(
      color: _accent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
          child: Text(
            text,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );

    return fullWidth ? SizedBox(width: double.infinity, child: button) : button;
  }

  Widget _buildInfoBox({
    required IconData icon,
    required String text,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _border, width: 1),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: _textSec, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                color: _textSec,
                fontSize: 12,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
