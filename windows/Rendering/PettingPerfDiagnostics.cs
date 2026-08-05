using System;
using System.Diagnostics;
using System.Windows.Threading;

namespace AliyaPet.Rendering;

/// <summary>
/// 抚摸输入热路径性能诊断（仅测量，不做优化）。每 5 秒汇总一次 PETTING_PERF 日志，不逐事件打印。
/// 统计：每秒 MouseMove 事件数 / 每秒处理样本数 / 每秒 Native 互动调用数 / 每秒 Dispatcher 调用数 /
/// Live2D 实际 FPS 与帧时间 P95/P99/最大 / 每秒托管分配 / GC Gen0/1/2 次数。
/// 线程规则：所有计数来源（MouseMove、消费计时器、ReactionController Tick、Live2D 渲染循环）均在 UI 线程，
/// 单线程直接累加，无需加锁。
/// </summary>
internal static class PettingPerfDiagnostics
{
    private const int WindowFrameCapacity = 4096;
    private const int AggregateMs = 5000;

    // 当前 5 秒窗口：帧时间数组（复用，不逐帧分配）
    private static readonly double[] WindowFrameMs = new double[WindowFrameCapacity];
    private static readonly double[] Scratch = new double[WindowFrameCapacity];
    private static int _windowFrameCount;

    private static long _mouseEvents;
    private static long _processedSamples;
    private static long _nativeCalls;
    private static long _dispatcherCalls;
    private static long _allocStart;
    private static int _gc0Start;
    private static int _gc1Start;
    private static int _gc2Start;
    private static long _windowStartTick;

    private static readonly DispatcherTimer Timer =
        new() { Interval = TimeSpan.FromMilliseconds(AggregateMs) };

    private static bool _initialized;

    /// <summary>UI 线程调用一次：启动 5 秒汇总计时器。</summary>
    public static void Initialize()
    {
        if (_initialized)
            return;
        _initialized = true;
        ResetWindow();
        Timer.Tick += (_, _) => Aggregate();
        Timer.Start();
    }

    public static void CountMouseEvent() => _mouseEvents++;
    public static void CountProcessedSample() => _processedSamples++;
    public static void CountNativeCall() => _nativeCalls++;
    public static void CountDispatcherCall() => _dispatcherCalls++;

    /// <summary>Live2D 渲染循环每帧调用（帧间隔毫秒）。</summary>
    public static void OnFrame(double intervalMs)
    {
        if (_windowFrameCount < WindowFrameCapacity)
        {
            WindowFrameMs[_windowFrameCount++] = intervalMs;
            SumFrameMs += intervalMs;
        }
    }

    private static void Aggregate()
    {
        double elapsedSec = Math.Max(0.001, (Stopwatch.GetTimestamp() - _windowStartTick) / (double)Stopwatch.Frequency);
        double fps = _windowFrameCount / elapsedSec;

        // 帧时间分位数：复用 scratch 数组排序，不分配
        Array.Copy(WindowFrameMs, Scratch, _windowFrameCount);
        Array.Sort(Scratch, 0, _windowFrameCount);
        double p95 = _windowFrameCount > 0 ? Percentile(Scratch, _windowFrameCount, 0.95) : 0;
        double p99 = _windowFrameCount > 0 ? Percentile(Scratch, _windowFrameCount, 0.99) : 0;
        double max = _windowFrameCount > 0 ? Scratch[_windowFrameCount - 1] : 0;
        double avg = _windowFrameCount > 0 ? SumFrameMs / _windowFrameCount : 0;

        long allocBytes = GC.GetTotalAllocatedBytes(true) - _allocStart;
        int gc0 = GC.CollectionCount(0) - _gc0Start;
        int gc1 = GC.CollectionCount(1) - _gc1Start;
        int gc2 = GC.CollectionCount(2) - _gc2Start;

        // 无事件且无帧时跳过，避免空闲期日志噪音
        if (_windowFrameCount == 0 && _mouseEvents == 0 && _processedSamples == 0)
        {
            ResetWindow();
            return;
        }

        AppLog.Info("PETTING_PERF\n" +
            "mouseEventsPerSec={0:0.#}\n" +
            "processedSamplesPerSec={1:0.#}\n" +
            "nativeCallsPerSec={2:0.#}\n" +
            "dispatcherCallsPerSec={3:0.#}\n" +
            "fps={4:0.#}\n" +
            "frameAvgMs={5:0.00}\n" +
            "frameP95Ms={6:0.00}\n" +
            "frameP99Ms={7:0.00}\n" +
            "frameMaxMs={8:0.00}\n" +
            "allocatedBytesPerSec={9:0.#}\n" +
            "gc0={10}\n" +
            "gc1={11}\n" +
            "gc2={12}",
            _mouseEvents / elapsedSec,
            _processedSamples / elapsedSec,
            _nativeCalls / elapsedSec,
            _dispatcherCalls / elapsedSec,
            fps,
            avg, p95, p99, max,
            allocBytes / elapsedSec,
            gc0, gc1, gc2);

        ResetWindow();
    }

    private static double SumFrameMs;
    private static double Percentile(double[] sorted, int count, double p)
    {
        int idx = Math.Min(count - 1, (int)(count * p));
        return sorted[idx];
    }

    private static void ResetWindow()
    {
        _windowStartTick = Stopwatch.GetTimestamp();
        _windowFrameCount = 0;
        SumFrameMs = 0;
        _mouseEvents = 0;
        _processedSamples = 0;
        _nativeCalls = 0;
        _dispatcherCalls = 0;
        _allocStart = GC.GetTotalAllocatedBytes(true);
        _gc0Start = GC.CollectionCount(0);
        _gc1Start = GC.CollectionCount(1);
        _gc2Start = GC.CollectionCount(2);
    }
}
