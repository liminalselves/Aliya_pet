/// 嘴部动画输出：每帧要写入的（含与时间平滑后的）变化值。
class MouthAnimationFrame {
  const MouthAnimationFrame(this.openY, this.form);

  /// 本帧张开度 0..1。
  final double openY;

  /// 本帧口型 -1..1。
  final double form;

  static const MouthAnimationFrame closed = MouthAnimationFrame(0, 0);

  @override
  bool operator ==(Object other) =>
      other is MouthAnimationFrame &&
      other.openY == openY &&
      other.form == form;

  @override
  int get hashCode => Object.hash(openY, form);

  @override
  String toString() => 'MouthAnimationFrame(openY: $openY, form: $form)';
}
