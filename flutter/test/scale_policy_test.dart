import 'package:aliya_pet/services/scale_policy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ScalePolicy.clampAbsolute', () {
    test('正常值原样通过', () {
      expect(ScalePolicy.clampAbsolute(1.0), 1.0);
      expect(ScalePolicy.clampAbsolute(0.1), 0.1);
      expect(ScalePolicy.clampAbsolute(8.0), 8.0);
    });

    test('超出绝对范围被夹紧', () {
      expect(ScalePolicy.clampAbsolute(0.0), ScalePolicy.absoluteMin);
      expect(ScalePolicy.clampAbsolute(-3), ScalePolicy.absoluteMin);
      expect(ScalePolicy.clampAbsolute(99), ScalePolicy.absoluteMax);
    });

    test('NaN/无穷回退到 1.0', () {
      expect(ScalePolicy.clampAbsolute(double.nan), 1.0);
      expect(ScalePolicy.clampAbsolute(double.infinity), 1.0);
      expect(ScalePolicy.clampAbsolute(double.negativeInfinity), 1.0);
    });
  });

  group('ScalePolicy.clampToRange', () {
    test('范围内原样通过', () {
      expect(ScalePolicy.clampToRange(1.5, (min: 0.5, max: 2.0)), 1.5);
    });

    test('越界夹紧到设备范围', () {
      expect(ScalePolicy.clampToRange(0.01, (min: 0.5, max: 2.0)), 0.5);
      expect(ScalePolicy.clampToRange(7.0, (min: 0.5, max: 2.0)), 2.0);
    });

    test('设备范围超出绝对范围时受绝对范围约束', () {
      expect(
        ScalePolicy.clampToRange(0.01, (min: 0.01, max: 99.0)),
        ScalePolicy.absoluteMin,
      );
      expect(
        ScalePolicy.clampToRange(99.0, (min: 0.01, max: 99.0)),
        ScalePolicy.absoluteMax,
      );
    });

    test('min>max 的异常范围被修正', () {
      expect(ScalePolicy.clampToRange(1.5, (min: 3.0, max: 0.5)), 1.5);
      expect(ScalePolicy.clampToRange(0.2, (min: 3.0, max: 0.5)), 0.5);
      expect(ScalePolicy.clampToRange(9.0, (min: 3.0, max: 0.5)), 3.0);
    });
  });

  group('ScalePolicy.viewportFitRange（Android 应用内固定视口）', () {
    // Hiyori 模型 scale=1 目标尺寸约为 562x796（含 1.18 余量），
    // 测试使用整数近似 560x796。
    test('标准视口：上限保证主体不被裁切', () {
      final r = ScalePolicy.viewportFitRange(
        unitW: 560, unitH: 796, viewportW: 512, viewportH: 768,
      );
      // 主体宽 = 560/1.18 ≈ 474.6，主体高 = 796/1.18 ≈ 674.6。
      // 宽度是瓶颈：上限 = 512/474.6 ≈ 1.079（高度上限 768/674.6 ≈ 1.138 更宽松）。
      final expectedMax = 512 / (560 / 1.18);
      expect(r.max, closeTo(expectedMax, 1e-6));
      // 下限 = 0.3×768/674.6 ≈ 0.341
      expect(r.min, closeTo(0.3 * 768 / (796 / 1.18), 1e-6));
      expect(r.min, greaterThanOrEqualTo(ScalePolicy.absoluteMin));
      // 默认 scale=1.0 必须在范围内（默认外观不变）。
      expect(r.min, lessThanOrEqualTo(1.0));
      expect(r.max, greaterThanOrEqualTo(1.0));
    });

    test('宽度是瓶颈时按宽度限制', () {
      final r = ScalePolicy.viewportFitRange(
        unitW: 560, unitH: 796, viewportW: 400, viewportH: 4000,
      );
      expect(r.max, closeTo(400 / (560 / 1.18), 1e-6));
    });

    test('极小视口：上下限都被绝对下限托底后退化', () {
      final r = ScalePolicy.viewportFitRange(
        unitW: 560, unitH: 796, viewportW: 30, viewportH: 40,
      );
      // maxByH = 40/674.6 ≈ 0.059 低于绝对下限 0.1 → 被托底为 0.1；
      // minScale 同样被托底为 0.1 → 退化为固定值。
      expect(r.min, r.max);
      expect(r.max, ScalePolicy.absoluteMin);
    });

    test('非法输入退化为 1.0', () {
      final r = ScalePolicy.viewportFitRange(
        unitW: 0, unitH: 0, viewportW: 512, viewportH: 768,
      );
      expect(r, (min: 1.0, max: 1.0));
    });
  });

  group('ScalePolicy.workAreaRange（Windows / 悬浮窗）', () {
    test('标准桌面：上下限由工作区与最小窗口推导', () {
      final r = ScalePolicy.workAreaRange(
        unitW: 560, unitH: 796,
        workW: 1920, workH: 1040, dpr: 1.0,
      );
      // maxByH = 1040/796 ≈ 1.307；maxByW = 1920/560 ≈ 3.43 → 取小
      expect(r.max, closeTo(1040 / 796, 1e-6));
      // minByH = 160/796 ≈ 0.201；minByW = 120/560 ≈ 0.214 → 取大
      expect(r.min, closeTo(120 / 560, 1e-6));
    });

    test('高 DPR：物理换算后范围收窄', () {
      final r = ScalePolicy.workAreaRange(
        unitW: 560, unitH: 796,
        workW: 1920, workH: 1040, dpr: 2.0,
      );
      expect(r.max, closeTo(1040 * 2 / 796, 1e-6));
      expect(r.min, closeTo(120 * 2 / 560, 1e-6));
    });

    test('上限永不超过绝对上限', () {
      final r = ScalePolicy.workAreaRange(
        unitW: 10, unitH: 10,
        workW: 8000, workH: 8000, dpr: 1.0,
      );
      expect(r.max, ScalePolicy.absoluteMax);
    });

    test('屏幕极小放不下最小窗口：退化固定值且在工作区内', () {
      final r = ScalePolicy.workAreaRange(
        unitW: 560, unitH: 796,
        workW: 100, workH: 100, dpr: 1.0,
      );
      expect(r.min, r.max);
      // 100/796 ≈ 0.126（窗口完整落进工作区）
      expect(r.max, closeTo(100 / 796, 1e-6));
    });
  });

  group('ScalePolicy.nextPreset', () {
    test('正常循环：0.5 → 1.0 → 2.0 → 回到 0.5', () {
      const range = (min: 0.1, max: 8.0);
      var v = ScalePolicy.nextPreset(0.3, min: range.min, max: range.max);
      expect(v, 0.5);
      v = ScalePolicy.nextPreset(v, min: range.min, max: range.max);
      expect(v, 1.0);
      v = ScalePolicy.nextPreset(v, min: range.min, max: range.max);
      expect(v, 2.0);
      v = ScalePolicy.nextPreset(v, min: range.min, max: range.max);
      expect(v, 0.5);
    });

    test('当前值略高于档位时跳过该档', () {
      final v = ScalePolicy.nextPreset(1.02, min: 0.1, max: 8.0);
      expect(v, 2.0);
    });

    test('范围收窄时档位被夹紧去重', () {
      // 0.5 和 2.0 都被夹出范围 → 只剩 1.0；补 min/max 形成两档。
      final v = ScalePolicy.nextPreset(1.0, min: 0.8, max: 1.2);
      expect(v, anyOf(0.8, 1.2));
    });

    test('范围过窄：返回夹紧后的当前值', () {
      final v = ScalePolicy.nextPreset(5.0, min: 1.0, max: 1.001);
      expect(v, closeTo(1.0, 0.01));
    });
  });
}
