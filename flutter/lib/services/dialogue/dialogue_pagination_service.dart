import '../../models/dialogue/dialogue_page.dart';

/// 气泡分页：
///   - 反斜杠 \ 作为人工分页符（显示时不包含）
///   - 无人工分页符时按标点与字符长度智能分页
///   - 不让标点单独出现在下一页开头；不切断英文单词/数字
///   - 超过 maxPages 时重新均衡分页
class DialoguePaginationService {
  static const int defaultSinglePageMaxChars = 18;
  static const int defaultMaxPages = 3;

  static const Set<String> _punctuation = {
    '，', '。', '？', '！', '、', '；', '：', '…', '～', '·',
    '?', '!', ',', ';', ':', '.',
  };

  /// 对最终文本分页。
  List<DialoguePage> paginate(String text,
      {int? singlePageMaxChars, int? maxPages}) {
    final target = (singlePageMaxChars ?? defaultSinglePageMaxChars).clamp(1, 1 << 30);
    final maxP = (maxPages ?? defaultMaxPages).clamp(1, 1 << 30);

    if (text.trim().isEmpty) {
      return const [DialoguePage(0, '')];
    }

    // 1. 人工分页符：显式拆分优先
    final explicitPages = text
        .split(r'\')
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty)
        .toList();
    if (explicitPages.length > 1) {
      if (explicitPages.length <= maxP) {
        return _toPages(explicitPages);
      }
      // 显式页数超过 maxPages：忽略显式分页，整体重新均衡
      final flat = explicitPages.join();
      return _rebalance(flat, target, maxP);
    }

    // 2. 智能分页
    final units = _tokenize(text);
    final pages = _pack(units, target);
    if (pages.length > maxP) {
      return _rebalance(text, target, maxP);
    }

    return _toPages(pages);
  }

  List<DialoguePage> _rebalance(String text, int target, int maxPages) {
    final units = _tokenize(text);
    final totalChars = units.fold<int>(0, (acc, u) => acc + u.text.length);
    final perPage = (totalChars / maxPages).ceil().clamp(1, 1 << 30);
    var pages = _pack(units, perPage);
    // 仍超过 maxPages 时从末尾向前合并，保证不粗暴截断、页数不超限
    while (pages.length > maxPages && pages.length > 1) {
      final merged = pages[pages.length - 2] + pages[pages.length - 1];
      pages.removeLast();
      pages[pages.length - 1] = merged;
    }
    return _toPages(pages);
  }

  List<String> _pack(List<_Unit> units, int target) {
    final pages = <String>[];
    var i = 0;
    while (i < units.length) {
      var j = i;
      var chars = 0;
      var lastBreak = -1;
      while (j < units.length) {
        final u = units[j];
        if (chars + u.text.length > target) break;
        chars += u.text.length;
        if (u.isPunct) lastBreak = j + 1;
        j++;
      }

      if (j >= units.length) {
        pages.add(_join(units, i, units.length));
        break;
      }

      int cut;
      if (lastBreak > i && lastBreak <= j) {
        cut = lastBreak;
      } else if (units[j].isPunct && chars + units[j].text.length <= target + 2) {
        cut = j + 1; // 吸收标点到本页末尾，避免下一页以标点开头
      } else {
        cut = j;
      }

      // 防止无进展（单个单元超过 target 时整体成一页，避免死循环）
      if (cut <= i) cut = i + 1;

      pages.add(_join(units, i, cut));
      i = cut;
    }

    // 清理空页
    pages.removeWhere((p) => p.isEmpty);
    return pages.isEmpty ? [''] : pages;
  }

  static String _join(List<_Unit> units, int start, int end) {
    final sb = StringBuffer();
    for (var i = start; i < end && i < units.length; i++) {
      sb.write(units[i].text);
    }
    return sb.toString().trim();
  }

  static List<DialoguePage> _toPages(List<String> texts) =>
      [for (var i = 0; i < texts.length; i++) DialoguePage(i, texts[i])];

  /// 拆分为不可再切分的单元：汉字单字 / 连续英文或数字词 / 标点。
  static List<_Unit> _tokenize(String text) {
    final result = <_Unit>[];
    var i = 0;
    while (i < text.length) {
      final c = text[i];
      if (_punctuation.contains(c)) {
        result.add(_Unit(c, true));
        i++;
        continue;
      }

      if (_isWordChar(c)) {
        final start = i;
        while (i < text.length && _isWordChar(text[i])) {
          i++;
        }
        result.add(_Unit(text.substring(start, i), false));
        continue;
      }

      result.add(_Unit(c, false));
      i++;
    }
    return result;
  }

  static bool _isWordChar(String c) {
    final code = c.codeUnitAt(0);
    return (code >= 0x61 && code <= 0x7A) ||
        (code >= 0x41 && code <= 0x5A) ||
        (code >= 0x30 && code <= 0x39);
  }
}

class _Unit {
  const _Unit(this.text, this.isPunct);

  final String text;
  final bool isPunct;
}
