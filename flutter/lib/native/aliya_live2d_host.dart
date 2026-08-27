import 'dart:ffi';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:ffi/ffi.dart';
import 'package:image/image.dart' as img;

import 'aliya_live2d_bindings.dart';

/// AliyaLive2D Host 高层封装：生命周期管理 + 常用操作。
///
/// 渲染流程（离屏 + CPU 读回，双平台一致）：
///   create → setAssetDirectory → loadModel → attachWindow/SetViewport
///   → （GLES 后端）uploadAllTextures → 每帧 update → render → copyFramePixels
class AliyaLive2DHost {
  AliyaLive2DHost._(this._handle, this._bindings);

  /// 创建并初始化 Host。加载失败抛 [AliyaNativeException]。
  factory AliyaLive2DHost.create() {
    final bindings = AliyaLive2DBindings.load();
    bindings.verifyApiVersion();
    _staticBindings = bindings; // 供 GC finalizer 使用（Dart finalizer 无法捕获局部对象）
    final handle = bindings.create();
    if (handle == nullptr) {
      throw AliyaNativeException(AliyaResult.errInitFailed, 'AliyaLive2D_Create 返回空句柄');
    }
    final host = AliyaLive2DHost._(handle, bindings);
    _finalizer.attach(host, handle, detach: host._detach);
    return host;
  }

  static final Finalizer<Pointer<Void>> _finalizer =
      Finalizer((handle) => _destroy(handle));

  static AliyaLive2DBindings? _staticBindings;

  static void _destroy(Pointer<Void> handle) {
    final bindings = _staticBindings;
    if (bindings != null && handle != nullptr) {
      bindings.destroy(handle);
    }
  }

  final Pointer<Void> _handle;
  final AliyaLive2DBindings _bindings;
  bool _detached = false;
  bool _disposed = false;

  void _detach() {
    _detached = true;
  }

  AliyaLive2DBindings get bindings => _bindings;
  Pointer<Void> get handle => _handle;

  /// 显式销毁（幂等）。不调用则由 GC finalizer 兜底。
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    if (!_detached) {
      _bindings.destroy(_handle);
      _detach();
    }
  }

  // ---- 生命周期 ----

  /// 设置资源根目录（UTF-8 绝对路径）。
  void setAssetDirectory(String root) {
    _check(_bindings.setAssetDirectory(_handle, root));
  }

  /// 加载模型（相对于资源根目录的 model3.json 路径，如 "Aliya/16.model3.json"）。
  void loadModel(String modelJsonPath) {
    _check(_bindings.loadModel(_handle, modelJsonPath));
  }

  /// 绑定视口并进入 Ready 状态（离屏渲染，hwnd 传空）。
  void attachWindow(int widthPx, int heightPx) {
    _check(_bindings.attachWindow(_handle, nullptr, widthPx, heightPx));
  }

  void setViewport(int widthPx, int heightPx) {
    _check(_bindings.setViewport(_handle, widthPx, heightPx));
  }

  // ---- 每帧 ----

  void update(double deltaSeconds) {
    _check(_bindings.update(_handle, deltaSeconds));
  }

  void render() {
    _check(_bindings.render(_handle));
  }

  /// 复制当前帧到 [dest]（尺寸由上次 viewport 决定）。
  void copyFramePixels(Pointer<Uint8> dest, int stride) {
    _check(_bindings.copyFramePixels(_handle, dest, stride));
  }

  /// 上传纹理（GLES 后端必调；D3D11 后端加载时已自动解码，可选覆盖）。
  void uploadTexture(int index, int width, int height, Pointer<Uint8> rgba) {
    _check(_bindings.uploadTexture(_handle, index, width, height, rgba));
  }

  /// GLES 后端：从 Flutter Asset 读取全部 PNG 并上传纹理。
  /// 需要 [pngBytesLoader] 提供"资源名 → PNG 字节"，便于测试注入。
  Future<void> uploadAllTexturesFromAssets(
    Future<Uint8List?> Function(String fileName) pngBytesLoader,
  ) async {
    final info = _bindings.getInfo(_handle);
    final textureNames = _modelTextureNames();
    debugPrint('UploadTextures: count=${info.textureCount} names=$textureNames');
    for (var i = 0; i < info.textureCount; i++) {
      if (i >= textureNames.length) break;
      final bytes = await pngBytesLoader(textureNames[i]);
      if (bytes == null) {
        debugPrint('UploadTextures: $i load null');
        continue;
      }
      final decoded = await _decodePng(bytes);
      if (decoded == null) {
        debugPrint('UploadTextures: $i decode null');
        continue;
      }
      final ptr = calloc<Uint8>(decoded.pixels.length);
      try {
        ptr.asTypedList(decoded.pixels.length).setAll(0, decoded.pixels);
        _check(_bindings.uploadTexture(_handle, i, decoded.width, decoded.height, ptr));
        debugPrint('UploadTextures: $i uploaded ${decoded.width}x${decoded.height}');
      } finally {
        calloc.free(ptr);
      }
    }
  }

  /// 解析 model3.json 获取纹理文件名列表（仅 GLES 后端需要）。
  List<String> _modelTextureNames() {
    // 从 model3.json 读取 "FileReferences.Textures"
    // 简化实现：解析保存的 model3 文本（由 loadModel 时缓存）。
    final json = _cachedModelJson;
    if (json == null) return const [];
    final textures = RegExp(r'"Textures"\s*:\s*\[([^\]]*)\]').firstMatch(json);
    if (textures == null) return const [];
    return RegExp(r'"([^"]+)"')
        .allMatches(textures.group(1)!)
        .map((m) => m.group(1)!)
        .toList();
  }

  String? _cachedModelJson;

  /// 记录 model3.json 原始文本（供纹理名解析）。由上层在加载前设置。
  set cachedModelJson(String? v) => _cachedModelJson = v;

  // ---- 参数 / 动作 ----

  void setScale(double scale) => _check(_bindings.setScale(_handle, scale));
  void setOpacity(double opacity) => _check(_bindings.setOpacity(_handle, opacity));
  void setState(String state, double intensity) =>
      _check(_bindings.setState(_handle, state, intensity));
  void playAction(String action) => _check(_bindings.playAction(_handle, action));
  /// 直接设置任意参数值（如 ParamCheek 脸红）。
  void setParameterValue(String id, double value) =>
      _check(_bindings.setParameterValue(_handle, id, value));
  void setLookTarget(double x, double y) =>
      _check(_bindings.setLookTarget(_handle, x, y));  void clearLookTarget() => _check(_bindings.clearLookTarget(_handle));
  void setLipSyncValue(double value) =>
      _check(_bindings.setLipSyncValue(_handle, value));
  void setGazeSpeed(double multiplier) =>
      _check(_bindings.setGazeSpeed(_handle, multiplier));
  /// 鼠标/指针静止多少秒后视线回正（0.1~30 秒）。
  void setMouseIdleTimeout(double seconds) =>
      _check(_bindings.setMouseIdleTimeout(_handle, seconds));
  void forceBlink() => _check(_bindings.forceBlink(_handle));
  void pause() => _check(_bindings.pause(_handle));
  void resume() => _check(_bindings.resume(_handle));
  bool hitTest(double x, double y) => _bindings.hitTest(_handle, x, y) == AliyaResult.ok;

  AliyaModelInfoData get info => _bindings.getInfo(_handle);
  /// 桌宠在当前 scale 下的目标窗口像素尺寸（含留边 margin）。
  ({double width, double height}) get modelTargetSize =>
      _bindings.getModelTargetSize(_handle);
  AliyaActionInfoData get actionInfo => _bindings.getActionInfo(_handle);
  AliyaBlinkInfoData get blinkInfo => _bindings.getBlinkInfo(_handle);
  AliyaMouthParamInfoData get mouthParamInfo => _bindings.getMouthParamInfo(_handle);
  AliyaInteractionParamInfoData get interactionParamInfo =>
      _bindings.getInteractionParamInfo(_handle);

  String get lastError => _bindings.lastError(_handle);
  List<String> get actions => _splitLines(_bindings.listActions(_handle));
  List<String> get earParams => _splitLines(_bindings.listEarParams(_handle));
  List<String> pollActionEvents() =>
      _splitLines(_bindings.pollActionEvents(_handle));

  void _check(int code) {
    if (code != AliyaResult.ok) {
      throw AliyaNativeException(code, lastError);
    }
  }

  static List<String> _splitLines(String s) =>
      s.split('\n').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
}

/// PNG 解码结果。
class DecodedImage {
  DecodedImage(this.width, this.height, this.pixels);

  final int width;
  final int height;
  final Uint8List pixels; // RGBA8，顶行在前
}

/// 使用纯 Dart image 包解码 PNG 为 RGBA 字节（绕开 Impeller 引擎 toByteData 返回全 0 的问题）。
Future<DecodedImage?> _decodePng(Uint8List bytes) async {
  try {
    final decoded = img.decodePng(bytes);
    if (decoded == null) return null;
    // 无 alpha 的 PNG 解码为 3 通道，必须转 4 通道（RGBA）再取字节，否则像素错位且 alpha 全 0
    final image4 = decoded.numChannels == 4 ? decoded : decoded.convert(numChannels: 4);
    final rgba = image4.getBytes(order: img.ChannelOrder.rgba);
    return DecodedImage(decoded.width, decoded.height, rgba);
  } catch (_) {
    return null;
  }
}
