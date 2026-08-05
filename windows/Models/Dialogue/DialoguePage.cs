namespace AliyaPet.Models.Dialogue;

/// <summary>分页后的单页气泡文本。</summary>
public sealed class DialoguePage
{
    public DialoguePage(int index, string text)
    {
        Index = index;
        Text = text;
    }

    public int Index { get; }

    /// <summary>页面显示文本（不含人工分页符 \ ）。</summary>
    public string Text { get; }
}
