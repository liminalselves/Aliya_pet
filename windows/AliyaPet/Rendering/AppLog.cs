using System;
using System.IO;

namespace AliyaPet.Rendering;

/// <summary>统一应用日志：写入 <AppBase>/Logs/aliya-pet.log。</summary>
internal static class AppLog
{
    private static readonly object Gate = new();
    private static string? _path;

    private static string Path
    {
        get
        {
            if (_path is null)
            {
                var dir = System.IO.Path.Combine(AppContext.BaseDirectory, "Logs");
                Directory.CreateDirectory(dir);
                _path = System.IO.Path.Combine(dir, "aliya-pet.log");
            }
            return _path;
        }
    }

    public static void Info(string format, params object?[] args)
    {
        Write("INFO", format, args);
    }

    public static void Warn(string format, params object?[] args)
    {
        Write("WARN", format, args);
    }

    public static void Error(string format, params object?[] args)
    {
        Write("ERROR", format, args);
    }

    private static void Write(string level, string format, object?[] args)
    {
        try
        {
            var message = args.Length == 0 ? format : string.Format(format, args);
            var line = $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss.fff} [{System.Environment.CurrentManagedThreadId}] [{level}] {message}";
            lock (Gate)
            {
                File.AppendAllText(Path, line + Environment.NewLine);
            }
        }
        catch
        {
            // 日志失败不影响程序运行
        }
    }
}
