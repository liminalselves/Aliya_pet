import 'package:flutter_test/flutter_test.dart';

import 'package:aliya_pet/main.dart';

void main() {
  testWidgets('App 启动冒烟测试', (WidgetTester tester) async {
    // 仅验证应用能构建（Live2D 依赖原生库，不在单测环境初始化）
    await tester.pumpWidget(const AliyaPetApp());
    expect(find.byType(AliyaPetApp), findsOneWidget);
  });
}
