using System;
using AliyaPet.Models.Mouth;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Mouth;

/// <summary>
/// Live2D 嘴型控制器：启动时检测当前模型真实嘴部参数，不写死。
/// 优先 ParamMouthOpenY / ParamMouthForm；只存在 OpenY 时只驱动张嘴幅度；
/// 两个都不存在时不崩溃、跳过嘴型并记录一次警告。
/// </summary>
public sealed class Live2DMouthController : IMouthController
{
    private readonly Func<Live2DCharacterRenderer?> _getRenderer;
    private bool _detected;
    private bool _available;
    private bool _hasOpenY;
    private bool _hasForm;
    private double _openYMin = 0;
    private double _openYMax = 1;
    private double _formMin = -1;
    private double _formMax = 1;
    private bool _warningLogged;

    public Live2DMouthController(Func<Live2DCharacterRenderer?> getRenderer)
    {
        _getRenderer = getRenderer;
    }

    /// <summary>模型重载（切换角色/重建渲染器）后重置检测缓存，下次使用重新检测。</summary>
    public void ResetDetection()
    {
        _detected = false;
        _available = false;
        _hasOpenY = false;
        _hasForm = false;
        _openYMin = 0;
        _openYMax = 1;
        _formMin = -1;
        _formMax = 1;
    }

    public bool IsAvailable
    {
        get
        {
            EnsureDetected();
            return _available;
        }
    }

    public void Write(MouthAnimationFrame frame)
    {
        EnsureDetected();
        var renderer = _getRenderer();
        if (renderer is null || !_available)
            return;

        double openY = Map(_openYMin, _openYMax, frame.OpenY);
        double form = _hasForm ? Map(_formMin, _formMax, frame.Form) : 0;
        try
        {
            renderer.SetMouthOverride(true, openY, form);
        }
        catch
        {
            // 写入失败不影响气泡
        }
    }

    public void Release()
    {
        var renderer = _getRenderer();
        if (renderer is null)
            return;
        try
        {
            renderer.SetMouthOverride(false, 0, 0);
        }
        catch
        {
            // 忽略
        }
    }

    private void EnsureDetected()
    {
        if (_detected)
            return;
        _detected = true;

        var renderer = _getRenderer();
        if (renderer is null)
        {
            _available = false;
            return;
        }

        try
        {
            var info = renderer.GetMouthParamInfo();
            _hasOpenY = info.hasOpenY;
            _hasForm = info.hasForm;
            _openYMin = info.openYMin;
            _openYMax = info.openYMax;
            _formMin = info.formMin;
            _formMax = info.formMax;

            if (_hasOpenY)
            {
                _available = true;
                AppLog.Info("MOUTH_PARAMS_DETECTED hasOpenY=1 hasForm={0} openYRange={1:0.###}~{2:0.###}",
                    _hasForm ? 1 : 0, _openYMin, _openYMax);
            }
            else if (!_warningLogged)
            {
                _warningLogged = true;
                AppLog.Warn("MOUTH_PARAMS_MISSING 模型无 ParamMouthOpenY/ParamMouthForm，跳过嘴型");
            }
        }
        catch
        {
            if (!_warningLogged)
            {
                _warningLogged = true;
                AppLog.Warn("MOUTH_PARAMS_DETECT_FAILED 嘴部参数检测失败，跳过嘴型");
            }
        }
    }

    private static double Map(double min, double max, double normalized)
    {
        if (min >= max)
            return min;
        return min + (max - min) * Math.Clamp(normalized, 0, 1);
    }
}
