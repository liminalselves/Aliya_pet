import 'dart:io';

import 'package:flutter/services.dart' show AssetManifest, rootBundle;

/// Live2D 模型资源管理：将 Flutter assets 解包到本地文件目录，
/// 供 Native 层（SetAssetDirectory/LoadModel）按文件系统路径加载。
class Live2DAssetManager {
  Live2DAssetManager(this.baseDir);

  /// 本地资源根目录（解包目标）。
  final Directory baseDir;

  /// Cubism Framework shader 文件（Framework 以相对路径 FrameworkShaders/*.fx|*.vert|*.frag 加载）。
  /// 解包采用 AssetManifest 动态枚举（目录内文件随 SDK 版本变化，不手写清单）。

  /// 将 [manifest] 中的资源从 Flutter assets 复制到 [baseDir]。
  /// 已存在且大小一致的文件跳过（增量解包）。
  Future<void> extractAll() async {
    // Framework shader 解包：
    // - Android（OpenGLES ES2）：Framework 用无前缀文件名，期望位于资源根目录
    // - Windows（D3D11）：Framework 用 FrameworkShaders/ 前缀
    final assetManifest = await AssetManifest.loadFromAssetBundle(rootBundle);
    final shaderAssets = assetManifest
        .listAssets()
        .where((p) => p.startsWith('assets/FrameworkShaders/'))
        .toList();
    for (final assetPath in shaderAssets) {
      final name = assetPath.substring('assets/FrameworkShaders/'.length);
      final bytes = await rootBundle.load(assetPath);
      final pixels = bytes.buffer.asUint8List();
      final subFile = File('${baseDir.path}/FrameworkShaders/$name');
      await subFile.parent.create(recursive: true);
      if (!await subFile.exists() ||
          bytes.lengthInBytes != await subFile.length()) {
        await subFile.writeAsBytes(pixels);
      }
      if (!Platform.isWindows) {
        // ES2 渲染器按无前缀文件名加载（assetRoot 根目录）
        final rootFile = File('${baseDir.path}/$name');
        if (!await rootFile.exists() ||
            bytes.lengthInBytes != await rootFile.length()) {
          await rootFile.writeAsBytes(pixels);
        }
      }
    }

    // 模型资源动态解包（AssetManifest 枚举 assets/live2d/ 下全部文件，新增模型无需改清单）
    final modelAssets = assetManifest
        .listAssets()
        .where((p) => p.startsWith('assets/live2d/'))
        .toList();
    for (final assetPath in modelAssets) {
      final rel = assetPath.substring('assets/live2d/'.length);
      await _extractTo(baseDir.path, assetPath, rel);
    }

    // 台词资源（assets/dialogue/ 递归）——解包到 <baseDir>/dialogue
    final dialogueAssets = assetManifest
        .listAssets()
        .where((p) => p.startsWith('assets/dialogue/'))
        .toList();
    for (final assetPath in dialogueAssets) {
      final rel = assetPath.substring('assets/dialogue/'.length);
      await _extractTo(baseDir.path, assetPath, 'dialogue/$rel');
    }

    // 互动区域配置（assets/interaction/）——解包到 <baseDir>/interaction
    final interactionAssets = assetManifest
        .listAssets()
        .where((p) => p.startsWith('assets/interaction/'))
        .toList();
    for (final assetPath in interactionAssets) {
      final rel = assetPath.substring('assets/interaction/'.length);
      await _extractTo(baseDir.path, assetPath, 'interaction/$rel');
    }
  }

  /// 将单个 asset 复制到 [destRoot] 下的相对路径 [rel]，已存在且大小一致时跳过。
  Future<void> _extractTo(
      String destRoot, String assetPath, String rel) async {
    final destFile = File('$destRoot/$rel');
    if (await destFile.exists()) {
      final bytes = await rootBundle.load(assetPath);
      if (bytes.lengthInBytes == await destFile.length()) {
        return; // 已解包且大小一致
      }
    }
    final bytes = await rootBundle.load(assetPath);
    await destFile.parent.create(recursive: true);
    await destFile.writeAsBytes(bytes.buffer.asUint8List());
  }

  /// 读取 model3.json 文本（纹理清单解析用）。
  /// [modelJsonPath] 形如 'Hiyori/Hiyori.model3.json'（相对资源根目录）。
  Future<String> readModelJson(String modelJsonPath) async {
    final file = File('${baseDir.path}/$modelJsonPath');
    return file.readAsString();
  }
}
