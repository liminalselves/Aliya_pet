using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using AliyaPet.Models.Dialogue;
using AliyaPet.Rendering;
using AliyaPet.Services.Mouth;

namespace AliyaPet.Services.Dialogue;

/// <summary>
/// 完整台词会话编排（气泡与嘴型统一控制，同一个会话令牌）：
///   1. 抽取原始台词（DialogueEntry）
///   2. 解析动态变量 -> 最终文本
///   3. 气泡分页
///   4. 构建嘴型时间轴
///   5. 显示第一页 -> 延迟 50~100ms 启动嘴型
///   6. 按时间翻页（嘴型时间轴继续播放）
///   7. 台词结束平滑闭嘴
///   8. 气泡额外保留 600~1200ms
///   9. 隐藏气泡 -> 清理播放状态
/// 任何环节被新会话/时间问候/切换角色/关闭打断时立即取消（CancellationToken）。
/// </summary>
public sealed class DialoguePlaybackService
{
    private readonly DialogueRepository _repository;
    private readonly DialogueSelectionService _selection;
    private readonly DialogueVariableService _variables;
    private readonly DialoguePaginationService _pagination;
    private readonly TextMouthTimelineBuilder _timelineBuilder;
    private readonly MouthAnimationRunner _mouthRunner;
    private readonly IDialogueDisplay _display;
    private readonly Random _random = new();

    public DialoguePlaybackService(
        DialogueRepository repository,
        DialogueSelectionService selection,
        DialogueVariableService variables,
        DialoguePaginationService pagination,
        TextMouthTimelineBuilder timelineBuilder,
        MouthAnimationRunner mouthRunner,
        IDialogueDisplay display)
    {
        _repository = repository;
        _selection = selection;
        _variables = variables;
        _pagination = pagination;
        _timelineBuilder = timelineBuilder;
        _mouthRunner = mouthRunner;
        _display = display;
    }

    /// <summary>按场景解析一次完整台词（抽取 -> 变量替换 -> 分页 -> 时间轴）。</summary>
    public ResolvedDialogue? ResolveScene(string scene)
    {
        var entry = _selection.Select(scene);
        if (entry is null)
            return null;

        var file = _repository.FindScene(scene);
        return ResolveEntry(entry, (file?.SinglePageMaxChars, file?.MaxPages));
    }

    /// <summary>从全部有效台词随机解析一条（随机说话用，默认分页配置）。</summary>
    public ResolvedDialogue? ResolveRandom()
    {
        var entry = _selection.SelectRandom();
        return entry is null ? null : ResolveEntry(entry, (null, null));
    }

    /// <summary>按场景 + tag 解析一条（抚摸台词等分组场景用）。</summary>
    public ResolvedDialogue? ResolveSceneTag(string scene, string tag, IReadOnlyCollection<string>? excludeIds = null, double weightBoost = 0)
    {
        var entry = _selection.SelectByTag(scene, tag, excludeIds, weightBoost);
        if (entry is null)
            return null;
        var file = _repository.FindScene(scene);
        return ResolveEntry(entry, (file?.SinglePageMaxChars, file?.MaxPages));
    }

    private ResolvedDialogue? ResolveEntry(DialogueEntry entry, (int? MaxChars, int? MaxPages) options)
    {
        if (string.IsNullOrWhiteSpace(entry.Text))
            return null;

        var resolvedText = _variables.Resolve(entry.Text, DateTime.Now);
        if (string.IsNullOrWhiteSpace(resolvedText))
            return null;

        var pages = _pagination.Paginate(resolvedText, options.MaxChars, options.MaxPages);
        if (pages.Count == 0)
            return null;

        var timeline = _timelineBuilder.Build(resolvedText);
        var pageStarts = _timelineBuilder.ComputePageStartMilliseconds(resolvedText, pages);

        return new ResolvedDialogue
        {
            Entry = entry,
            FinalText = resolvedText,
            Pages = pages,
            MouthTimeline = timeline,
            PageStartMilliseconds = pageStarts,
            MouthTotalMilliseconds = timeline.TotalMilliseconds
        };
    }

    /// <summary>播放一次完整会话。被取消时停止旧翻页与旧嘴型，不再触碰 UI。</summary>
    public async Task PlayAsync(ResolvedDialogue resolved, CancellationToken token)
    {
        if (resolved is null)
            return;

        try
        {
            token.ThrowIfCancellationRequested();

            // 5. 显示第一页，延迟约 60ms 后启动嘴型
            _display.ShowPage(resolved.Pages[0].Text);
            var mouthTask = _mouthRunner.StartSession(resolved.MouthTimeline!, token);

            // 6. 按时间翻页（嘴型时间轴继续播放）
            var stopwatch = Stopwatch.StartNew();
            for (int i = 1; i < resolved.Pages.Count; i++)
            {
                int targetMs = resolved.PageStartMilliseconds[i];
                int remaining = targetMs - (int)stopwatch.ElapsedMilliseconds;
                if (remaining > 0)
                    await Task.Delay(remaining, token);
                token.ThrowIfCancellationRequested();
                _display.ShowPage(resolved.Pages[i].Text);
            }

            // 7. 等待嘴型时间轴结束（台词结束后由 runner 平滑闭嘴）
            await mouthTask.WaitAsync(token);
            token.ThrowIfCancellationRequested();

            // 8. 气泡额外保留 600~1200ms
            int retention = _random.Next(600, 1201);
            await Task.Delay(retention, token);
            token.ThrowIfCancellationRequested();

            // 9. 隐藏气泡并清理
            _display.HideBubble();
        }
        catch (OperationCanceledException)
        {
            AppLog.Info("DIALOGUE_SESSION_CANCELLED scene={0} id={1}", resolved.Entry.Id, resolved.Entry.Id);
        }
        catch (Exception ex)
        {
            AppLog.Error("DIALOGUE_PLAYBACK_ERROR id={0} error={1}", resolved.Entry.Id, ex.Message);
            _display.HideBubble();
        }
        finally
        {
            if (token.IsCancellationRequested)
            {
                // 被新会话/时间问候/切换角色等打断：气泡与嘴型交由新会话接管，这里不再修改 UI。
            }
            else
            {
                _mouthRunner.StopNow();
            }
        }
    }
}
