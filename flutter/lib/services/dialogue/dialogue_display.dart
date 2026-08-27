/// 气泡显示回调（由 UI 层实现，保持服务与渲染框架解耦）。
abstract class DialogueDisplay {
  void showPage(String pageText);

  void hideBubble();
}
