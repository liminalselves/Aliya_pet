import 'package:aliya_pet/models/interaction/hit_area_definition.dart';
import 'package:aliya_pet/models/interaction/interaction_context.dart';
import 'package:aliya_pet/services/interaction/click_sequence_service.dart';
import 'package:aliya_pet/services/interaction/drag_reaction_service.dart';
import 'package:aliya_pet/services/interaction/petting_gesture_recognizer.dart';
import 'package:aliya_pet/services/interaction/pointer_proximity_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('HitAreaDefinition', () {
    test('椭圆命中', () {
      final area = HitAreaDefinition(
          id: 'head', x: 0.5, y: 0.3, width: 0.4, height: 0.3);
      expect(area.contains(0.5, 0.3, false), isTrue);
      expect(area.contains(0.9, 0.9, false), isFalse);
    });

    test('矩形命中与镜像', () {
      final area = HitAreaDefinition(
          id: 'ear_left', type: 'rect', x: 0.2, y: 0.2, width: 0.1, height: 0.1);
      expect(area.contains(0.2, 0.2, false), isTrue);
      // 镜像后左耳区域移到右侧
      expect(area.contains(0.2, 0.2, true), isFalse);
      expect(area.contains(0.8, 0.2, true), isTrue);
    });
  });

  group('ClickSequenceService', () {
    test('3 秒内 3 次触发疑惑', () {
      final service = ClickSequenceService();
      expect(service.registerClick(), ClickResult.none);
      expect(service.registerClick(), ClickResult.none);
      expect(service.registerClick(), ClickResult.doubt);
    });
  });

  group('DragReactionService', () {
    test('快速拖动判定', () {
      final service = DragReactionService();
      service.beginDrag();
      service.onDragMove(500);
      final wasFast = service.endDrag();
      expect(wasFast, isTrue);
      // 结束后不再处于拖动状态
      expect(service.isDragging, isFalse);
      // 未处于拖动时 endDrag 返回 false
      final again = service.endDrag();
      expect(again, isFalse);
    });

    test('慢速拖动不算快速', () {
      final service = DragReactionService();
      service.beginDrag();
      service.onDragMove(50);
      final wasFast = service.endDrag();
      expect(wasFast, isFalse);
    });
  });

  group('PointerProximityService', () {
    test('速度平滑', () {
      final service = PointerProximityService();
      service.update(InteractionContext(
        normX: 0.1,
        normY: 0.1,
        viewportPxX: 10,
        viewportPxY: 10,
        deltaSeconds: 0.016,
        leftPressed: false,
      ));
      service.update(InteractionContext(
        normX: 0.2,
        normY: 0.1,
        viewportPxX: 30,
        viewportPxY: 10,
        deltaSeconds: 0.016,
        leftPressed: false,
      ));
      expect(service.smoothedVelXPxPerSec, greaterThan(0));
    });
  });

  group('PettingGestureRecognizer', () {
    test('未激活时返回 invalid', () {
      final recognizer = PettingGestureRecognizer();
      final result = recognizer.update(_ctx(0, 0, 0.016));
      expect(result.isValid, isFalse);
    });

    test('水平往返抚摸可产生反转', () {
      final recognizer = PettingGestureRecognizer();
      recognizer.startGesture();
      // 模拟水平左右往返：>18px 划动 + 反转
      var x = 100.0;
      for (var i = 0; i < 30; i++) {
        x += 6; // 右移
        recognizer.update(_ctx(x, 100, 0.016));
      }
      for (var i = 0; i < 30; i++) {
        x -= 6; // 左移（反转）
        recognizer.update(_ctx(x, 100, 0.016));
      }
      expect(recognizer.reversalCount, greaterThanOrEqualTo(1));
    });
  });
}

InteractionContext _ctx(double x, double y, double dt) => InteractionContext(
      normX: x / 512,
      normY: y / 768,
      viewportPxX: x,
      viewportPxY: y,
      deltaSeconds: dt,
      leftPressed: true,
    );
