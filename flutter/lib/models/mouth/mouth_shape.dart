/// 一个口型状态：嘴巴张开度（0..1）与一个口型类型（-1..1）。
/// 模型无此参数时以 0 处理。
class MouthShape {
  const MouthShape(this.openY, this.form);

  /// 张开度：0=闭合，1=最大张开（写入前按模型真实范围映射）。
  final double openY;

  /// 口型变形，-1..1（模型存在 ParamMouthForm 时写入）。
  final double form;

  static const MouthShape closed = MouthShape(0, 0);

  @override
  bool operator ==(Object other) =>
      other is MouthShape && other.openY == openY && other.form == form;

  @override
  int get hashCode => Object.hash(openY, form);

  @override
  String toString() => 'MouthShape(openY: $openY, form: $form)';
}
