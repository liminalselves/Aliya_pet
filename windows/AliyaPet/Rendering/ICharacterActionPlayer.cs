namespace AliyaPet.Rendering;

/// <summary>
/// 统一角色动作播放接口：PNG（分帧/WPF 动画）与 Live2D（参数动作库）分别实现。
/// 业务层通过 MainWindow.PlayCharacterAction 路由，禁止到处写 if(isLive2D)。
/// </summary>
public interface ICharacterActionPlayer
{
    /// <summary>该实现是否支持指定动作 id。</summary>
    bool CanPlay(string actionId);

    /// <summary>播放动作。返回是否真正开始。</summary>
    bool Play(string actionId);

    /// <summary>停止当前动作。</summary>
    void Stop(string reason);

    bool IsPlaying { get; }

    string? CurrentActionId { get; }
}
