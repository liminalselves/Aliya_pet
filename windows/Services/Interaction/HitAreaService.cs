using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using AliyaPet.Models.Interaction;
using AliyaPet.Rendering;

namespace AliyaPet.Services.Interaction;

/// <summary>
/// 互动区域服务：优先模型真实 HitArea；模型缺失时回退到配置
/// Assets/interaction/aliya_hit_areas.json（人物渲染区域归一化坐标）。
/// 兼容人物缩放/高DPI/窗口移动/PNG/Live2D 可见区域/左右镜像。
/// </summary>
public sealed class HitAreaService
{
    private readonly List<HitAreaDefinition> _areas = new();

    /// <summary>是否为调试模式（显示半透明轮廓）。默认关闭。</summary>
    public bool DebugEnabled { get; private set; }

    /// <summary>是否镜像（左右互换）。默认 false。</summary>
    public bool IsMirrored { get; set; }

    public void LoadFromDirectory(string rootDirectory)
    {
        _areas.Clear();
        string configPath = Path.Combine(rootDirectory, "interaction", "aliya_hit_areas.json");
        try
        {
            if (!File.Exists(configPath))
            {
                AppLog.Warn("HIT_AREA_CONFIG_MISSING path={0}", configPath);
                return;
            }
            using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
            if (doc.RootElement.TryGetProperty("areas", out var areas))
            {
                foreach (var a in areas.EnumerateArray())
                {
                    var def = new HitAreaDefinition
                    {
                        Id = a.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
                        Type = a.TryGetProperty("type", out var t) ? t.GetString() ?? "ellipse" : "ellipse",
                        X = a.TryGetProperty("x", out var x) ? x.GetDouble() : 0.5,
                        Y = a.TryGetProperty("y", out var y) ? y.GetDouble() : 0.5,
                        Width = a.TryGetProperty("width", out var w) ? w.GetDouble() : 0.3,
                        Height = a.TryGetProperty("height", out var h) ? h.GetDouble() : 0.3,
                        Priority = a.TryGetProperty("priority", out var p) ? p.GetInt32() : 0
                    };
                    if (!string.IsNullOrEmpty(def.Id))
                        _areas.Add(def);
                }
            }
            AppLog.Info("HIT_AREA_LOAD count={0}", _areas.Count);
        }
        catch (Exception ex)
        {
            AppLog.Warn("HIT_AREA_CONFIG_FAILED error={0}", ex.Message);
        }
    }

    /// <summary>返回当前配置的区域（供调试覆盖层渲染）。</summary>
    public IReadOnlyList<HitAreaDefinition> Areas => _areas;

    public void SetDebugEnabled(bool enabled) => DebugEnabled = enabled;

    /// <summary>在归一化点命中的优先级最高的区域 ID；未命中返回 null。</summary>
    public string? HitAreaAt(double nx, double ny)
    {
        HitAreaDefinition? best = null;
        foreach (var area in _areas)
        {
            if (area.Contains(nx, ny, IsMirrored))
            {
                if (best is null || area.Priority > best.Priority)
                    best = area;
            }
        }
        return best?.Id;
    }

    public HitAreaDefinition? GetArea(string id)
    {
        return _areas.FirstOrDefault(a => a.Id == id);
    }

    public bool IsInArea(string id, double nx, double ny)
    {
        var area = GetArea(id);
        return area is not null && area.Contains(nx, ny, IsMirrored);
    }
}
