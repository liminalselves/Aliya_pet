import 'dart:math' as math;

import 'package:flutter/material.dart';

/// 启动/加载界面：透明窗口上的居中品牌加载动画。
///
/// 只在初始化阶段显示，不参与 Live2D 渲染循环，成本很低。
class StartupLoadingView extends StatefulWidget {
  const StartupLoadingView({super.key, this.status});

  /// 当前初始化状态文本；为 null 时显示默认加载文案。
  final String? status;

  @override
  State<StartupLoadingView> createState() => _StartupLoadingViewState();
}

class _StartupLoadingViewState extends State<StartupLoadingView>
    with SingleTickerProviderStateMixin {
  static const Color _bg = Color(0xFF000000);
  static const Color _surface = Color(0xFF1A1A1A);
  static const Color _accent = Color(0xFF0A84FF);
  static const Color _text = Color(0xFFFFFFFF);
  static const Color _textSec = Color(0xFF999999);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _failed => widget.status?.contains('失败') ?? false;

  String get _statusText {
    final status = widget.status;
    if (status == null || status.trim().isEmpty) return '正在唤醒 Aliya';
    return status;
  }

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(color: _bg),
      child: Center(
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: TweenAnimationBuilder<double>(
            // 首帧就要能看清，不要从全透明开始
            tween: Tween(begin: 0.8, end: 1.0),
            duration: const Duration(milliseconds: 400),
            curve: Curves.easeOut,
            builder: (context, t, child) {
              return Opacity(
                opacity: t.clamp(0.0, 1.0),
                child: Transform.scale(scale: 0.95 + 0.05 * t, child: child),
              );
            },
            child: RepaintBoundary(
              child: AnimatedBuilder(
                animation: _controller,
                builder: (context, _) {
                  return Container(
                    padding: const EdgeInsets.all(32),
                    decoration: BoxDecoration(
                      color: _surface,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: const Color(0xFF2A2A2A),
                        width: 1,
                      ),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // 加载图标
                        SizedBox(
                          width: 64,
                          height: 64,
                          child: Stack(
                            alignment: Alignment.center,
                            children: [
                              // 旋转轨道
                              CustomPaint(
                                size: const Size(64, 64),
                                painter: _LoadingSpinnerPainter(
                                  progress: _controller.value,
                                  color: _accent,
                                ),
                              ),
                              // 中心图标
                              const Icon(
                                Icons.pets,
                                color: _text,
                                size: 28,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 20),
                        // 品牌名称
                        const Text(
                          'Aliya Pet',
                          style: TextStyle(
                            color: _text,
                            fontSize: 20,
                            fontWeight: FontWeight.w600,
                            letterSpacing: -0.3,
                          ),
                        ),
                        const SizedBox(height: 8),
                        // 状态文本
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (_failed)
                              const Icon(
                                Icons.error_outline,
                                color: Color(0xFFFF453A),
                                size: 14,
                              )
                            else
                              SizedBox(
                                width: 12,
                                height: 12,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  valueColor: AlwaysStoppedAnimation(_accent),
                                ),
                              ),
                            const SizedBox(width: 8),
                            Text(
                              _statusText,
                              style: TextStyle(
                                color: _failed
                                    ? const Color(0xFFFF453A)
                                    : _textSec,
                                fontSize: 13,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 简约旋转加载动画
class _LoadingSpinnerPainter extends CustomPainter {
  const _LoadingSpinnerPainter({
    required this.progress,
    required this.color,
  });

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide / 2 - 2;
    final start = progress * math.pi * 2;

    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..color = color;

    // 绘制一个旋转的圆弧
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      start,
      math.pi * 1.2,
      false,
      paint,
    );
  }

  @override
  bool shouldRepaint(_LoadingSpinnerPainter oldDelegate) =>
      oldDelegate.progress != progress;
}
