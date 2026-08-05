using System;
using AliyaPet.Models.Interaction;

namespace AliyaPet.Services.Interaction;

/// <summary>指针邻近与速度追踪（平滑滤波），供手掌旋转、脸部看向、拖动判定使用。</summary>
public sealed class PointerProximityService
{
    private bool _has;
    private DateTime _lastTime;
    private double _lastPxX;
    private double _lastPxY;
    private double _smoothVelX;
    private double _smoothVelY;
    private double _smoothNormX;
    private double _smoothNormY;

    public void Update(InteractionContext ctx)
    {
        var now = DateTime.UtcNow;
        if (_has)
        {
            double dt = Math.Max(0.001, (now - _lastTime).TotalSeconds);
            double velX = (ctx.ViewportPxX - _lastPxX) / dt;
            double velY = (ctx.ViewportPxY - _lastPxY) / dt;
            _smoothVelX = _smoothVelX * 0.6 + velX * 0.4;
            _smoothVelY = _smoothVelY * 0.6 + velY * 0.4;
        }
        else
        {
            _smoothVelX = 0;
            _smoothVelY = 0;
        }
        _lastTime = now;
        _lastPxX = ctx.ViewportPxX;
        _lastPxY = ctx.ViewportPxY;
        _smoothNormX = ctx.NormX;
        _smoothNormY = ctx.NormY;
        _has = true;
    }

    public void Reset()
    {
        _has = false;
        _smoothVelX = 0;
        _smoothVelY = 0;
    }

    public double SmoothedVelXPxPerSec => _smoothVelX;
    public double SmoothedVelYPxPerSec => _smoothVelY;
    public double SmoothedNormX => _smoothNormX;
    public double SmoothedNormY => _smoothNormY;
}
