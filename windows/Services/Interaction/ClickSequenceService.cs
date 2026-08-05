using System;
using System.Collections.Generic;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Interaction;

/// <summary>连续点击检测（3秒3次疑惑 / 4秒5次吐槽 / 6秒8次点击冷却）。</summary>
public sealed class ClickSequenceService
{
    public enum ClickResult
    {
        None,
        /// <summary>3 秒内 3 次：疑惑反应。</summary>
        Doubt,
        /// <summary>4 秒内 5 次：轻微吐槽。</summary>
        Comment,
        /// <summary>6 秒内 8 次：进入点击冷却。</summary>
        Cooldown
    }

    private readonly List<DateTime> _clicks = new();
    private DateTime _cooldownUntil;
    private readonly Random _random = new();

    public bool IsInCooldown => DateTime.UtcNow < _cooldownUntil;

    public ClickResult RegisterClick()
    {
        var now = DateTime.UtcNow;
        _clicks.Add(now);
        while (_clicks.Count > 0 && (now - _clicks[0]).TotalSeconds > 6)
            _clicks.RemoveAt(0);

        if (IsInCooldown)
            return ClickResult.Cooldown;

        int within6 = CountWithin(now, 6);
        if (within6 >= 8)
        {
            _cooldownUntil = now.AddSeconds(_random.Next(2, 6));
            AppLog.Info("CLICK_SEQUENCE_COOLDOWN seconds={0:0.#}", (_cooldownUntil - now).TotalSeconds);
            return ClickResult.Cooldown;
        }

        if (CountWithin(now, 5) >= 4)
            return ClickResult.Comment;
        if (CountWithin(now, 3) >= 3)
            return ClickResult.Doubt;
        return ClickResult.None;
    }

    public void Reset()
    {
        _clicks.Clear();
        _cooldownUntil = default;
    }

    private int CountWithin(DateTime now, double seconds)
    {
        int count = 0;
        for (int i = _clicks.Count - 1; i >= 0; i--)
        {
            if ((now - _clicks[i]).TotalSeconds <= seconds)
                count++;
            else
                break;
        }
        return count;
    }
}
