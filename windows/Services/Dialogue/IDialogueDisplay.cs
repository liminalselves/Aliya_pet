namespace AliyaPet.Services.Dialogue;

/// <summary>气泡显示回调（由窗口实现，保持服务与 WPF 解耦）。</summary>
public interface IDialogueDisplay
{
    void ShowPage(string pageText);
    void HideBubble();
}
