import 'dart:math' as math;

/// 缩放策略：双端统一的 scale 数学规则（纯函数，无平台依赖，可单元测试）。
///
/// scale 语义：模型渲染高度（物理像素）= 675 × scale（见 native live2d_model）。
/// 目标窗口/视口尺寸 = 模型渲染尺寸 × 1.18 动作余量，与 scale 线性相关。
///
/// 双端差异只在于“窗口是否随 scale 调整”：
/// - Windows：窗口随 scale 调整，范围由屏幕工作区与最小窗口推导（[workAreaRange]）。
/// - Android 应用内：视口固定，scale 只改变模型在视口内的大小，
///   范围由视口适配推导（[viewportFitRange]），避免模型被裁切或缩到不可见。
/// - Android 悬浮窗：窗口随 scale 调整（同 Windows），范围由屏幕尺寸推导。
class ScalePolicy {
  const ScalePolicy._();

  /// 绝对缩放范围：任何设备、任何入口都不会超出。
  static const double absoluteMin = 0.1;
  static const double absoluteMax = 8.0;

  /// 滚轮/按钮单档倍率。
  static const double stepFactor = 1.08;

  /// 尺寸档位（循环切换 / 菜单快捷按钮的基础档）。
  static const List<double> sizePresets = [0.5, 1.0, 2.0];

  /// 窗口最小逻辑尺寸（Windows 窗口 / Android 悬浮窗）：保证桌宠仍可交互。
  static const double minWindowLogicalW = 120.0;
  static const double minWindowLogicalH = 160.0;

  /// 目标尺寸中动作余量占比（与 native ComputeTargetPixelSize 的 1.18 对应）。
  static const double marginRatio = 1.18;

  /// 固定视口下模型主体至少占视口高度的比例（再小就缩到看不清了）。
  static const double _minFillRatio = 0.30;

  /// 判断两个 scale 是否可视作相等（持久化/档位去重的统一精度）。
  static bool sameValue(double a, double b) => (a - b).abs() < 0.005;

  /// 把任意输入夹紧到绝对范围；NaN/无穷等非法值回退到 1.0。
  static double clampAbsolute(double v) {
    if (v.isNaN || v.isInfinite) return 1.0;
    return v.clamp(absoluteMin, absoluteMax).toDouble();
  }

  /// 把任意输入夹紧到指定设备范围（范围本身先做合法性修正）。
  static double clampToRange(double v, ({double min, double max}) range) {
    final lo = clampAbsolute(math.min(range.min, range.max));
    final hi = clampAbsolute(math.max(range.min, range.max));
    return clampAbsolute(v).clamp(lo, hi).toDouble();
  }

  /// 固定视口适配范围（Android 应用内）：窗口不随 scale 调整。
  ///
  /// [unitW]/[unitH]：scale=1 时目标窗口尺寸（含动作余量），与视口同一单位。
  /// - 上限：模型主体（不含余量）不超过视口，再大主体就会被裁切；
  /// - 下限：模型主体不低于视口高度的 [_minFillRatio]，再小就缩到看不清。
  static ({double min, double max}) viewportFitRange({
    required double unitW,
    required double unitH,
    required double viewportW,
    required double viewportH,
  }) {
    if (unitW < 8 || unitH < 8 || viewportW < 8 || viewportH < 8) {
      return (min: 1.0, max: 1.0);
    }
    // 主体尺寸 = 目标尺寸 / marginRatio。
    final bodyUnitW = unitW / marginRatio;
    final bodyUnitH = unitH / marginRatio;

    final maxByW = viewportW / bodyUnitW;
    final maxByH = viewportH / bodyUnitH;
    final maxScale = clampAbsolute(math.min(maxByW, maxByH));

    final minScale = clampAbsolute(_minFillRatio * viewportH / bodyUnitH);

    if (maxScale < minScale) {
      // 视口极小：优先保证不裁切（哪怕模型会偏小）。
      return (min: maxScale, max: maxScale);
    }
    return (min: minScale, max: maxScale);
  }

  /// 工作区范围（Windows 窗口 / Android 悬浮窗）：窗口随 scale 调整。
  ///
  /// [unitW]/[unitH]：scale=1 时目标窗口物理像素（含动作余量）。
  /// [workW]/[workH]：屏幕工作区逻辑尺寸；[dpr]：逻辑 → 物理换算。
  /// - 上限：窗口完整落在工作区内；
  /// - 下限：窗口不小于最小逻辑尺寸（[minWinW]×[minWinH]）。
  static ({double min, double max}) workAreaRange({
    required double unitW,
    required double unitH,
    required double workW,
    required double workH,
    required double dpr,
    double minWinW = minWindowLogicalW,
    double minWinH = minWindowLogicalH,
  }) {
    if (unitW < 8 || unitH < 8 || workW <= 1 || workH <= 1 || dpr <= 0) {
      return (min: 1.0, max: 1.0);
    }
    final minByW = minWinW * dpr / unitW;
    final minByH = minWinH * dpr / unitH;
    final minScale = math.max(absoluteMin, math.max(minByW, minByH));

    final maxByW = workW * dpr / unitW;
    final maxByH = workH * dpr / unitH;
    final maxScale = math.min(absoluteMax, math.min(maxByW, maxByH));

    if (maxScale < minScale) {
      // 屏幕极小，连绝对下限都放不下：优先保证窗口完整落在工作区内。
      final capped = clampAbsolute(maxScale);
      return (min: capped, max: capped);
    }
    return (min: minScale, max: maxScale);
  }

  /// 档位循环：基础档夹紧到范围并去重后，返回大于 current 的最小档；
  /// 当前已是最大档则回到最小档。范围过窄时返回 current。
  static double nextPreset(
    double current, {
    required double min,
    required double max,
  }) {
    final lo = math.min(min, max);
    final hi = math.max(min, max);
    if (hi - lo < 0.005) return clampToRange(current, (min: lo, max: hi));

    final presets = <double>[];
    for (final base in sizePresets) {
      final v = base.clamp(lo, hi).toDouble();
      if (!presets.any((p) => sameValue(p, v))) presets.add(v);
    }
    // 基础档全被夹成同一个值：补 min/max 两档，保证循环切换仍有效。
    if (presets.length < 2) {
      if (!presets.any((p) => sameValue(p, lo))) presets.add(lo);
      if (!presets.any((p) => sameValue(p, hi))) presets.add(hi);
    }
    presets.sort();
    if (presets.isEmpty) return clampToRange(current, (min: lo, max: hi));

    for (final p in presets) {
      if (p > current + 0.01) return p;
    }
    return presets.first;
  }
}
