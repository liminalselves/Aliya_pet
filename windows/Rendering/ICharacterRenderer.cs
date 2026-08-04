namespace AliyaPet.Rendering;

/// <summary>人物渲染模式。</summary>
public enum CharacterRenderMode
{
    /// <summary>原有模式（静态 PNG + WPF 变换动画）。</summary>
    Existing = 0,

    /// <summary>Live2D 模式（Cubism Native + D3D11，托管层 WriteableBitmap 呈现）。</summary>
    Live2D = 1
}

/// <summary>人物状态（映射到 Live2D 参数效果）。与现有业务状态一一对应。</summary>
public enum CharacterState
{
    Idle,
    Move,
    Drag,
    Click,
    Sleep,
    Wake,
    Entrance,
    Exit
}

/// <summary>人物渲染器统一接口。业务层不直接操作 Cubism 参数。</summary>
public interface ICharacterRenderer : IDisposable
{
    void Start();
    void Update(double deltaSeconds);
    void Resize(int widthDip, int heightDip, double dpiScaleX, double dpiScaleY);
    void SetScale(double scale);
    void SetOpacity(double opacity);
    void SetState(CharacterState state, double intensity);
    void PlayAction(string actionName);
    void SetExpression(string expressionName);
    void SetLookTarget(double x01, double y01);
    void ClearLookTarget();
    void SetLipSyncValue(double value);
    bool HitTest(double xDip, double yDip);
    void Pause();
    void Resume();
}

