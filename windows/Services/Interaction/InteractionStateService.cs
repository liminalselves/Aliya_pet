using AliyaPet.Models.Interaction;

namespace AliyaPet.Services.Interaction;

/// <summary>当日互动状态服务（跨天自动清零）。</summary>
public sealed class InteractionStateService
{
    private readonly InteractionState _state = new();

    public InteractionState State => _state;

    public void EnsureFresh() => _state.EnsureDayFresh();

    public void BeginPetting() => _state.BeginPetting(System.DateTime.Now);

    public void EndPetting(long durationMs) => _state.EndPetting(durationMs);

    public int PettingCountToday => _state.HeadPettingCountToday;

    public bool WasRecentlyUsed(string id) => _state.WasRecentlyUsed(id);

    public void RecordDialogueId(string id) => _state.RecordDialogueId(id);
}
