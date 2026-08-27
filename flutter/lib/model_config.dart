/// 当前使用的 Live2D 模型配置（换模型只需修改这里）。
///
/// - Aliya：自定义角色（头/身/表情，无手臂骨骼）
/// - Hiyori：官方示例（完整骨骼：手臂/手/腿），动作表现更丰富
class ModelConfig {
  ModelConfig._();

  /// 模型所在目录名（assets/live2d/ 下）。
  static const String dirName = 'Hiyori';

  /// model3.json 相对路径（相对 assets/live2d/）。
  static const String modelJson = 'Hiyori/Hiyori.model3.json';
}
