using System;

namespace AliyaPet.Services.Interaction;

/// <summary>长按检测（抚摸模式接管时不会被触发）。</summary>
public sealed class LongPressService
{
    private DateTime? _pressStart;
    private bool _moved;

    public void Start()
    {
        _pressStart = DateTime.UtcNow;
        _moved = false;
    }

    public void Cancel()
    {
        _pressStart = null;
        _moved = false;
    }

    public void NotifyMoved()
    {
        _moved = true;
    }

    public bool IsActive => _pressStart is not null && !_moved;

    /// <summary>是否已满足长按时长（1200ms）。</summary>
    public bool CheckFired()
    {
        return _pressStart is not null && !_moved
               && (DateTime.UtcNow - _pressStart.Value).TotalMilliseconds >= 1200;
    }
}
