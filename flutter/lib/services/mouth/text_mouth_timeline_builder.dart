import 'dart:math' as math;

import '../../models/dialogue/dialogue_page.dart';
import '../../models/mouth/mouth_shape.dart';
import '../../models/mouth/mouth_timeline.dart';
import '../../models/mouth/mouth_timeline_item.dart';
import 'pinyin_mouth_mapper.dart';

/// 台词文本 → 嘴型时间轴：
///   去除气泡分页符 → 分割汉字/英文/数字/标点 → 中文转拼音 → 韵母映射嘴型
///   → 标点停顿 → 生成时间轴（每帧由 MouthAnimationRunner 平滑写入）。
/// 拼音转换完全离线（预计算表）；表外汉字回退自然开合。
class TextMouthTimelineBuilder {
  TextMouthTimelineBuilder(this._mapper, {math.Random? random})
      : _random = random ?? math.Random();

  final PinyinMouthMapper _mapper;
  final math.Random _random;

  static const Set<String> _numberDigits = {'0','1','2','3','4','5','6','7','8','9'};

  static const Map<String, int> _pauseRangeMs = {
    '、': 100, // 顿号 ~80-120
    '，': 180, // 逗号 ~140-220
    '。': 320, // 句号 ~260-380
    '？': 350, // 问号 ~280-420
    '！': 290, // 感叹号 ~220-360
    '…': 525, // 省略号 ~400-650
  };

  static const int _pageBreakPauseMinMs = 350;
  static const int _pageBreakPauseMaxMs = 550;

  /// 由最终台词（含人工分页符 \）构建嘴型时间轴。
  MouthTimeline build(String fullText) {
    final items = <MouthTimelineItem>[];
    if (fullText.trim().isEmpty) {
      return MouthTimeline(items);
    }

    final pacingCount = _countSpeechUnits(fullText);
    final baseMs = _getBaseSyllableMs(pacingCount);
    var t = 0;

    for (final unit in _tokenize(fullText)) {
      if (unit == r'\') {
        final pause = _random.nextInt(_pageBreakPauseMaxMs - _pageBreakPauseMinMs + 1) + _pageBreakPauseMinMs;
        items.add(MouthTimelineItem(t, pause, MouthShape.closed, isPause: true));
        t += pause;
        continue;
      }

      if (_isPunctuation(unit)) {
        final mid = _pauseRangeMs[unit] ?? 160;
        final lo = math.max(60, mid - 40);
        final hi = mid + 40;
        final actual = _random.nextInt(hi - lo + 1) + lo;
        items.add(MouthTimelineItem(t, actual, MouthShape.closed, isPause: true));
        t += actual;
        continue;
      }

      // 单个汉字
      if (unit.length == 1 && _isCjk(unit.codeUnitAt(0))) {
        t = _appendCjkSyllable(items, unit, t, baseMs);
        continue;
      }

      // 数字串 -> 中文读法近似展开
      if (unit.split('').every(_numberDigits.contains)) {
        for (final ch in _numberToSyllables(unit)) {
          t = _appendCjkSyllable(items, ch, t, baseMs);
        }
        continue;
      }

      // 英文词 -> 按元音分组近似
      for (final ch in unit.split('')) {
        t = _appendLatinLetter(items, ch, t, baseMs);
      }
    }

    return MouthTimeline(items);
  }

  /// 计算每个气泡页的开始时间（毫秒），用于翻页与嘴型同步。
  List<int> computePageStartMilliseconds(
      String fullText, List<DialoguePage> pages) {
    final pacingCount = _countSpeechUnits(fullText);
    final starts = <int>[0];
    var cumulative = 0;
    for (var i = 0; i + 1 < pages.length; i++) {
      cumulative += _estimateSegmentDuration(pages[i].text, pacingCount);
      starts.add(cumulative);
    }
    return starts;
  }

  /// 与 build 使用相同节奏常量的确定性估时（用于翻页对齐）。
  int _estimateSegmentDuration(String segment, int pacingCount) {
    if (segment.isEmpty) return 0;
    final baseMs = _getBaseSyllableMs(pacingCount);
    var total = 0;
    for (final unit in _tokenize(segment)) {
      if (unit == r'\') {
        total += (_pageBreakPauseMinMs + _pageBreakPauseMaxMs) ~/ 2;
        continue;
      }
      if (_isPunctuation(unit)) {
        total += _pauseRangeMs[unit] ?? 160;
        continue;
      }
      if (unit.length == 1 && _isCjk(unit.codeUnitAt(0))) {
        total += baseMs;
        if (_mapper.isClosedInit(unit)) total += 40;
        continue;
      }
      if (unit.split('').every(_numberDigits.contains)) {
        total += _numberToSyllables(unit).length * baseMs;
        continue;
      }
      total += unit.length * (baseMs ~/ 2 + 10);
    }
    return total;
  }

  int _appendCjkSyllable(
      List<MouthTimelineItem> items, String ch, int t, int baseMs) {
    final category = _mapper.getFinalCategory(ch);
    var shape = _mapper.getShape(category, _random.nextDouble());

    if (_mapper.isClosedInit(ch)) {
      // b/p/m：先短暂闭嘴
      final closedMs = _random.nextInt(21) + 30;
      items.add(MouthTimelineItem(
          t, closedMs, MouthShape(_random.nextDouble() * 0.06, 0)));
      t += closedMs;
      shape = MouthShape(math.max(0.3, shape.openY), shape.form);
    } else if (_mapper.isSoftInit(ch)) {
      // f：轻微张嘴，不必完全闭合
      shape = MouthShape(math.min(0.35, shape.openY * 0.55), shape.form * 0.5);
    }

    final syllable = _applyJitter(baseMs);
    items.add(MouthTimelineItem(t, syllable, shape));
    return t + syllable;
  }

  int _appendLatinLetter(
      List<MouthTimelineItem> items, String ch, int t, int baseMs) {
    final lower = ch.toLowerCase();
    MouthShape shape;
    if (lower == 'a') {
      shape = _mapper.getShape(FinalCategory.a, _random.nextDouble());
    } else if (lower == 'e') {
      shape = _mapper.getShape(FinalCategory.e, _random.nextDouble());
    } else if (lower == 'i' || lower == 'y') {
      shape = _mapper.getShape(FinalCategory.i, _random.nextDouble());
    } else if (lower == 'o') {
      shape = _mapper.getShape(FinalCategory.o, _random.nextDouble());
    } else if (lower == 'u') {
      shape = _mapper.getShape(FinalCategory.u, _random.nextDouble());
    } else {
      shape = MouthShape(_random.nextDouble() * 0.08, 0); // 辅音近似闭合
    }

    final isVowel = 'aeiouy'.contains(lower);
    final duration = isVowel
        ? _applyJitter(baseMs)
        : math.max(35, _applyJitter(baseMs) ~/ 2);
    items.add(MouthTimelineItem(t, duration, shape));
    return t + duration;
  }

  int _applyJitter(int baseMs) {
    // 音节时长 ±10%
    final delta = (baseMs * 0.10).round();
    return math.max(60, baseMs + _random.nextInt(delta * 2 + 1) - delta);
  }

  int _countSpeechUnits(String text) {
    var count = 0;
    for (final unit in _tokenize(text)) {
      if (unit == r'\' || _isPunctuation(unit)) continue;
      if (unit.length == 1 && _isCjk(unit.codeUnitAt(0))) {
        count++;
        continue;
      }
      if (unit.split('').every(_numberDigits.contains)) {
        count += _numberToSyllables(unit).length;
        continue;
      }
      count += unit.length;
    }
    return count;
  }

  static int _getBaseSyllableMs(int speechUnits) {
    if (speechUnits <= 6) return 150; // 短句稍慢
    if (speechUnits <= 14) return 132;
    return 112; // 长句适度加快
  }

  /// 数字 -> 中文读法近似音节（如 3026 -> 三/千/零/二/十/六，17 -> 十/七）。
  static List<String> _numberToSyllables(String digits) {
    const digitNames = '零一二三四五六七八九';
    final result = <String>[];
    final len = digits.length;
    if (len > 4) {
      // 超出千位时按位直读
      for (final d in digits.split('')) {
        result.add(digitNames[d.codeUnitAt(0) - '0'.codeUnitAt(0)]);
      }
      return result;
    }

    for (var i = 0; i < len; i++) {
      final d = digits.codeUnitAt(i) - '0'.codeUnitAt(0);
      final place = len - i - 1;
      if (d == 0) {
        if (digits.substring(i + 1).split('').any((c) => c != '0')) {
          result.add(digitNames[0]);
        }
        continue;
      }
      if (d == 1 && place == 1 && len == 2) {
        result.add(digitNames[1]); // 十
        continue;
      }
      result.add(digitNames[d]);
      if (place == 3) {
        result.add('千');
      } else if (place == 2) {
        result.add('百');
      } else if (place == 1) {
        result.add('十');
      }
    }
    return result;
  }

  static List<String> _tokenize(String text) {
    final tokens = <String>[];
    var i = 0;
    while (i < text.length) {
      final c = text[i];
      if (c == r'\') {
        tokens.add(r'\');
        i++;
        continue;
      }
      if (_isPunctuation(c)) {
        tokens.add(c);
        i++;
        continue;
      }
      if (_isCjk(c.codeUnitAt(0))) {
        tokens.add(c);
        i++;
        continue;
      }
      final isLetterOrDigit = _isLetter(c) || _numberDigits.contains(c);
      if (isLetterOrDigit) {
        final start = i;
        while (i < text.length &&
            (_isLetter(text[i]) || _numberDigits.contains(text[i]))) {
          i++;
        }
        tokens.add(text.substring(start, i));
        continue;
      }
      tokens.add(c);
      i++;
    }
    return tokens;
  }

  static bool _isLetter(String c) {
    final code = c.codeUnitAt(0);
    return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
  }

  static bool _isCjk(int code) => code >= 0x4E00 && code <= 0x9FFF;

  static bool _isPunctuation(String unit) {
    if (unit.length != 1) return false;
    return _pauseRangeMs.containsKey(unit) ||
        '；：～·'.contains(unit);
  }
}
