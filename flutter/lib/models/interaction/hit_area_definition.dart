/// 命中区域定义（归一化坐标，相对宠物渲染区域）。
class HitAreaDefinition {
  HitAreaDefinition({
    this.id = '',
    this.type = 'ellipse',
    this.x = 0.5,
    this.y = 0.5,
    this.width = 0.3,
    this.height = 0.3,
    this.priority = 0,
  });

  /// 区域 ID：head/face/ear_left/ear_right/hair/body/hand/tablet/head_pet_zone。
  final String id;

  /// 形状：ellipse / rect。
  final String type;

  /// 中心归一化 X（0..1）。
  final double x;

  /// 中心归一化 Y（0..1，向下为 0）。
  final double y;

  /// 归一化宽度（0..1）。
  final double width;

  /// 归一化高度（0..1）。
  final double height;

  /// 重叠时的优先级（数值大者优先）。
  final int priority;

  bool contains(double nx, double ny, bool mirrored) {
    final cx = mirrored ? 1.0 - x : x;
    final cy = y;
    if (type == 'rect') {
      final halfW = width / 2;
      final halfH = height / 2;
      return nx >= cx - halfW &&
          nx <= cx + halfW &&
          ny >= cy - halfH &&
          ny <= cy + halfH;
    }
    // 椭圆
    final dx = (nx - cx) / (width / 2 > 1e-6 ? width / 2 : 1e-6);
    final dy = (ny - cy) / (height / 2 > 1e-6 ? height / 2 : 1e-6);
    return dx * dx + dy * dy <= 1.0;
  }

  /// 归一化包围盒（含镜像处理）。
  (double, double, double, double) getBounds(bool mirrored) {
    final cx = mirrored ? 1.0 - x : x;
    return (cx - width / 2, y - height / 2, width, height);
  }
}
