import 'dart:convert';
import 'dart:io';

import '../../models/interaction/hit_area_definition.dart';

/// 互动区域服务：从 Assets/interaction/aliya_hit_areas.json 加载
/// （人物渲染区域归一化坐标）。兼容人物缩放/高DPI/窗口移动/左右镜像。
class HitAreaService {
  final List<HitAreaDefinition> _areas = [];

  // 高频使用的抚摸头区域：加载时缓存引用，避免热路径每次查找
  HitAreaDefinition? _headPetZone;

  /// 是否为调试模式（显示半透明轮廓）。默认关闭。
  bool debugEnabled = false;

  /// 是否镜像（左右互换）。默认 false。
  bool isMirrored = false;

  void loadFromDirectory(String rootDirectory) {
    _areas.clear();
    _headPetZone = null;
    final configPath = '$rootDirectory${Platform.pathSeparator}interaction'
        '${Platform.pathSeparator}aliya_hit_areas.json';
    try {
      final file = File(configPath);
      if (!file.existsSync()) {
        return;
      }
      final doc = jsonDecode(file.readAsStringSync());
      if (doc is Map<String, dynamic> && doc['areas'] is List) {
        for (final a in (doc['areas'] as List)) {
          final m = a as Map<String, dynamic>;
          final def = HitAreaDefinition(
            id: (m['id'] as String?) ?? '',
            type: (m['type'] as String?) ?? 'ellipse',
            x: (m['x'] as num?)?.toDouble() ?? 0.5,
            y: (m['y'] as num?)?.toDouble() ?? 0.5,
            width: (m['width'] as num?)?.toDouble() ?? 0.3,
            height: (m['height'] as num?)?.toDouble() ?? 0.3,
            priority: (m['priority'] as num?)?.toInt() ?? 0,
          );
          if (def.id.isNotEmpty) {
            _areas.add(def);
            if (def.id == 'head_pet_zone') {
              _headPetZone = def;
            }
          }
        }
      }
    } catch (_) {
      // 配置解析失败，忽略
    }
  }

  /// 返回当前配置的区域（供调试覆盖层渲染）。
  List<HitAreaDefinition> get areas => List.unmodifiable(_areas);

  /// 在归一化点命中的优先级最高的区域 ID；未命中返回 null。
  String? hitAreaAt(double nx, double ny) {
    HitAreaDefinition? best;
    for (final area in _areas) {
      if (area.contains(nx, ny, isMirrored)) {
        if (best == null || area.priority > best.priority) {
          best = area;
        }
      }
    }
    return best?.id;
  }

  HitAreaDefinition? getArea(String id) {
    for (final a in _areas) {
      if (a.id == id) return a;
    }
    return null;
  }

  bool isInArea(String id, double nx, double ny) {
    final area = getArea(id);
    return area != null && area.contains(nx, ny, isMirrored);
  }

  /// 头部抚摸区域命中（缓存引用，热路径使用）。
  bool isInHeadPetZone(double nx, double ny) =>
      _headPetZone != null && _headPetZone!.contains(nx, ny, isMirrored);

  /// 头部抚摸区域定义（供上层预计算窗口 DIP 矩形）。
  HitAreaDefinition? get headPetZone => _headPetZone;
}
