import '../../models/mouth/mouth_animation_frame.dart';

/// 嘴型写入通道（Live2D 模式使用；PNG 模式不提供实时嘴型）。
abstract class MouthController {
  /// 写入通道是否可用（Live2D 且模型存在嘴部参数）。
  bool get isAvailable;

  /// 写入当前帧嘴型（每帧由 MouthAnimationRunner 调用）。
  void write(MouthAnimationFrame frame);

  /// 释放通道（关闭覆盖，恢复回调后状态）。
  void release();
}
