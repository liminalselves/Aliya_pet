/// 多页对话的单个分页（纯文本）。
class DialoguePage {
  const DialoguePage(this.index, this.text);

  final int index;

  /// 页面显示文本（可能含人工分页符 \）。
  final String text;
}
