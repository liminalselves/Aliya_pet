/// 程序化反应（head/face/ear 等部位的确定性小动作）。
class ProceduralReaction {
  const ProceduralReaction({
    required this.type,
    this.strength = 0.5,
    this.areaId,
  });

  final ProceduralReactionType type;

  /// 强度 0..1。
  final double strength;

  /// 目标区域 ID（可选）。
  final String? areaId;

  static ProceduralReaction eyesAndTilt(double strength) =>
      ProceduralReaction(type: ProceduralReactionType.headTiltAndEyes, strength: strength);

  static ProceduralReaction lookAtThenAway(double strength) =>
      ProceduralReaction(type: ProceduralReactionType.lookAtThenAway, strength: strength);

  static ProceduralReaction earTwitch(double strength, String areaId) =>
      ProceduralReaction(
          type: ProceduralReactionType.earTwitch, strength: strength, areaId: areaId);

  static ProceduralReaction eyesWiden(double strength) =>
      ProceduralReaction(type: ProceduralReactionType.eyesWiden, strength: strength);

  static ProceduralReaction doubt(double strength) =>
      ProceduralReaction(type: ProceduralReactionType.doubt, strength: strength);

  static ProceduralReaction blush(double strength) =>
      ProceduralReaction(type: ProceduralReactionType.blush, strength: strength);
}

/// 程序化反应类型。
enum ProceduralReactionType {
  none,

  /// 微惊讶 + 头部小角度倾斜。
  headTiltAndEyes,

  /// 看向（相机）再移开。
  lookAtThenAway,

  /// 对应区域的小幅抽动。
  earTwitch,

  /// 眼睛睁大（惊讶）。
  eyesWiden,

  /// 疑惑反应。
  doubt,

  /// 脸红（ParamCheek），缓慢变红再缓慢消退。
  blush,
}
