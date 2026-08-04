using System.Windows;
using System.Windows.Threading;
using AliyaPet.Rendering;

namespace AliyaPet;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
DispatcherUnhandledException += (_, args) =>
        {
            AppLog.Error("DispatcherUnhandledException: {0}", args.Exception);
            AppLog.Error("堆栈: {0}", args.Exception.StackTrace);
            // 标记已处理，防止进程崩溃。
            // Live2D 等可选功能异常不应终止宠物进程。
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            AppLog.Error("AppDomain UnhandledException: {0}", args.ExceptionObject);
        };
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            AppLog.Error("UnobservedTaskException: {0}", args.Exception);
        };
    }
}
