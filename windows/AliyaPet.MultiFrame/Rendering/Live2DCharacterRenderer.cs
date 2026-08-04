using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AliyaPet.Rendering;

public sealed class Live2DCharacterRenderer : Grid, IDisposable
{
    private const string VirtualHost = "aliya.local";
    private readonly WebView2CompositionControl _webView;
    private bool _disposed;

    public Live2DCharacterRenderer()
    {
        _webView = new WebView2CompositionControl
        {
            DefaultBackgroundColor = System.Drawing.Color.Transparent,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            IsHitTestVisible = false
        };
        Children.Add(_webView);
    }

    public bool IsReady { get; private set; }

    public event EventHandler? Ready;
    public event EventHandler<string>? LoadFailed;

    public async Task InitializeAsync()
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(Live2DCharacterRenderer));

        var indexPath = Path.Combine(AppContext.BaseDirectory, "Live2DWeb", "index.html");
        if (!File.Exists(indexPath))
        {
            Fail($"Live2D 页面不存在：{indexPath}");
            return;
        }

        try
        {
            _webView.CoreWebView2InitializationCompleted += OnInitializationCompleted;
            await _webView.EnsureCoreWebView2Async();
            if (_webView.CoreWebView2 is null)
            {
                Fail("WebView2 初始化失败");
                return;
            }

            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                AppContext.BaseDirectory,
                CoreWebView2HostResourceAccessKind.Allow);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.CoreWebView2.ProcessFailed += OnProcessFailed;
            _webView.NavigationCompleted += OnNavigationCompleted;
            _webView.Source = new Uri($"https://{VirtualHost}/Live2DWeb/index.html");
        }
        catch (Exception ex)
        {
            Fail(ex.Message);
        }
    }

    public void SetLookTarget(double x, double y) =>
        Post(new { type = "look", x = Math.Clamp(x, -1, 1), y = Math.Clamp(y, -1, 1) });

    public void SetSpeaking(bool speaking) => Post(new { type = "speaking", value = speaking });

    public void TriggerClick() => Post(new { type = "click" });

    private void Post(object message)
    {
        if (!_disposed && IsReady && _webView.CoreWebView2 is not null)
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    private void OnInitializationCompleted(object? sender, CoreWebView2InitializationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
            Fail(e.InitializationException?.Message ?? "WebView2 初始化失败");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
            Fail($"Live2D 页面加载失败：{e.WebErrorStatus}");
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e) =>
        Fail($"Live2D 渲染进程异常：{e.ProcessFailedKind}");

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            var root = message.RootElement;
            var type = root.TryGetProperty("type", out var typeElement)
                ? typeElement.GetString()
                : null;

            if (type == "ready")
            {
                IsReady = true;
                Ready?.Invoke(this, EventArgs.Empty);
            }
            else if (type == "error")
            {
                var detail = root.TryGetProperty("message", out var detailElement)
                    ? detailElement.GetString()
                    : null;
                Fail(detail ?? "Live2D 模型加载失败");
            }
        }
        catch (JsonException ex)
        {
            Fail($"Live2D 消息解析失败：{ex.Message}");
        }
    }

    private void Fail(string message)
    {
        if (!_disposed)
            LoadFailed?.Invoke(this, message);
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        IsReady = false;
        _webView.CoreWebView2InitializationCompleted -= OnInitializationCompleted;
        _webView.NavigationCompleted -= OnNavigationCompleted;
        if (_webView.CoreWebView2 is not null)
        {
            _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
            _webView.CoreWebView2.ProcessFailed -= OnProcessFailed;
        }
        _webView.Dispose();
        Children.Clear();
    }
}
