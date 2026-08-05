using System;

namespace AliyaPet.Services.Interaction;

/// <summary>快速拖动反应：眼睛短暂睁大 + 头部受限惯性 + 每次拖动最多一次台词。</summary>
public sealed class DragReactionService
{
    private const double FastDragSpeedThreshold = 250; // 物理像素/秒

    private bool _dragging;
    private double _maxSpeedPxPerSec;
    private bool _dialogueTriggered;

    public bool IsDragging => _dragging;

    public void BeginDrag()
    {
        _dragging = true;
        _maxSpeedPxPerSec = 0;
        _dialogueTriggered = false;
    }

    public void OnDragMove(double speedPxPerSec)
    {
        if (!_dragging)
            return;
        if (double.IsFinite(speedPxPerSec))
            _maxSpeedPxPerSec = Math.Max(_maxSpeedPxPerSec, Math.Abs(speedPxPerSec));
    }

    /// <summary>结束拖动。返回是否为快速拖动；台词是否已在本轮触发。</summary>
    public (bool wasFast, bool dialogueTriggered) EndDrag()
    {
        if (!_dragging)
            return (false, false);
        _dragging = false;
        bool wasFast = _maxSpeedPxPerSec >= FastDragSpeedThreshold;
        if (wasFast && !_dialogueTriggered)
        {
            _dialogueTriggered = true;
            return (true, true);
        }
        return (wasFast, _dialogueTriggered);
    }
}
