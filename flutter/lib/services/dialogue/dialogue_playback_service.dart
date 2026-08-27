import 'dart:async';
import 'dart:math' as math;

import '../../models/dialogue/dialogue_entry.dart';
import '../../models/dialogue/resolved_dialogue.dart';
import '../../models/mouth/mouth_timeline.dart';
import '../mouth/mouth_animation_runner.dart';
import '../mouth/text_mouth_timeline_builder.dart';
import 'dialogue_display.dart';
import 'dialogue_pagination_service.dart';
import 'dialogue_repository.dart';
import 'dialogue_selection_service.dart';
import 'dialogue_variable_service.dart';

/// 完整台词会话编排（气泡与嘴型统一控制，同一个会话令牌）：
///   1. 抽取原始台词（DialogueEntry）
///   2. 解析动态变量 -> 最终文本
///   3. 气泡分页
///   4. 构建嘴型时间轴
///   5. 显示第一页 -> 延迟 50~100ms 启动嘴型
///   6. 按时间翻页（嘴型时间轴继续播放）
///   7. 台词结束平滑闭嘴
///   8. 气泡额外保留 600~1200ms
///   9. 隐藏气泡 -> 清理播放状态
/// 任何环节被新会话/时间问候/切换角色/关闭打断时立即取消。
class DialoguePlaybackService {
  DialoguePlaybackService({
    required this.repository,
    required this.selection,
    required this.variables,
    required this.pagination,
    required this.timelineBuilder,
    required this.mouthRunner,
    required this.display,
  });

  final DialogueRepository repository;
  final DialogueSelectionService selection;
  final DialogueVariableService variables;
  final DialoguePaginationService pagination;
  final TextMouthTimelineBuilder timelineBuilder;
  final MouthAnimationRunner mouthRunner;
  final DialogueDisplay display;

  final math.Random _random = math.Random();

  /// 当前会话令牌：新会话/取消时使旧会话立即失效。
  int _sessionToken = 0;

  /// 按场景解析一次完整台词（抽取 -> 变量替换 -> 分页 -> 时间轴）。
  ResolvedDialogue? resolveScene(String scene) {
    final entry = selection.select(scene);
    final file = repository.findScene(scene);
    return _resolveEntry(entry,
        maxChars: file?.singlePageMaxChars, maxPages: file?.maxPages);
  }

  /// 从全部有效台词随机解析一条（随机说话用，默认分页配置）。
  ResolvedDialogue? resolveRandom() {
    final entry = selection.selectRandom();
    return _resolveEntry(entry);
  }

  /// 按场景 + tag 解析一条（抚摸台词等分组场景用）。
  ResolvedDialogue? resolveSceneTag(String scene, String tag,
      {Set<String>? excludeIds, double weightBoost = 0}) {
    final entry = selection.selectByTag(scene, tag,
        excludeIds: excludeIds, weightBoost: weightBoost);
    if (entry == null) return null;
    final file = repository.findScene(scene);
    return _resolveEntry(entry,
        maxChars: file?.singlePageMaxChars, maxPages: file?.maxPages);
  }

  ResolvedDialogue? _resolveEntry(DialogueEntry entry,
      {int? maxChars, int? maxPages}) {
    final text = entry.text;
    if (text == null || text.trim().isEmpty) return null;

    final resolvedText = variables.resolve(text, DateTime.now());
    if (resolvedText.trim().isEmpty) return null;

    final pages = pagination.paginate(resolvedText,
        singlePageMaxChars: maxChars, maxPages: maxPages);
    if (pages.isEmpty) return null;

    final timeline = timelineBuilder.build(resolvedText);
    final pageStarts =
        timelineBuilder.computePageStartMilliseconds(resolvedText, pages);

    return ResolvedDialogue(
      entry: entry,
      finalText: resolvedText,
      pages: pages,
      mouthTimeline: timeline,
      pageStartMilliseconds: pageStarts,
      mouthTotalMilliseconds: timeline.totalMilliseconds,
    );
  }

  /// 播放一次完整会话。被取消时停止旧翻页与旧嘴型，不再触碰 UI。
  Future<void> playAsync(ResolvedDialogue resolved) async {
    // H4 修复：空 pages 保护
    if (resolved.pages.isEmpty) return;
    
    // H3 修复：pageStartMilliseconds 与 pages 长度不一致保护
    if (resolved.pageStartMilliseconds.length < resolved.pages.length) {
      // 回退到均匀翻页（或直接返回，取决于业务需求）
      return;
    }
    
    final token = ++_sessionToken;

    try {
      // 5. 显示第一页，延迟约 60ms 后启动嘴型
      display.showPage(resolved.pages.first.text);
      final mouthFuture = mouthRunner.startSession(
        resolved.mouthTimeline ?? _emptyTimeline(),
      );

      // 6. 按时间翻页（嘴型时间轴继续播放）
      final stopwatch = Stopwatch()..start();
      for (var i = 1; i < resolved.pages.length; i++) {
        final targetMs = resolved.pageStartMilliseconds[i];
        final remaining = targetMs - stopwatch.elapsedMilliseconds;
        if (remaining > 0) {
          await Future<void>.delayed(Duration(milliseconds: remaining));
        }
        if (token != _sessionToken) return; // 被新会话打断
        display.showPage(resolved.pages[i].text);
      }

      // 7. 等待嘴型时间轴结束（台词结束后由 runner 平滑闭嘴）
      await mouthFuture;
      if (token != _sessionToken) return;

      // 8. 气泡额外保留 600~1200ms
      final retention = _random.nextInt(601) + 600;
      await Future<void>.delayed(Duration(milliseconds: retention));
      if (token != _sessionToken) return;

      // 9. 隐藏气泡并清理
      display.hideBubble();
    } catch (_) {
      // 播放错误：清理气泡
      display.hideBubble();
    } finally {
      if (token == _sessionToken) {
        mouthRunner.stopNow();
      }
      // 被新会话打断：气泡与嘴型交由新会话接管，这里不再修改 UI
    }
  }

  /// 取消当前会话（新会话开始时自动调用）。
  void cancelCurrent() {
    _sessionToken++;
    mouthRunner.requestCancel();
  }

  static MouthTimeline _emptyTimeline() => MouthTimeline([]);
}
