package top.liminalselves.aliyapet

import android.content.Context
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.CookieManager
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 共享 WebView 工厂：同一套 ui/dist 前端跑在 App 内与悬浮窗两个容器里。
 *
 * 资源经 WebViewAssetLoader 以 https://appassets.androidplatform.net/ 虚拟域提供
 * （assets/pet/ 前缀映射）——https 同源语义下 fetch/XHR 正常，而 file:// 会被
 * WebView 的 CORS 拦截，无法加载 model3.json 等子资源。
 */
object PetWebViewFactory {
    private const val DOMAIN = "https://appassets.androidplatform.net"
    const val PET_URL = "$DOMAIN/index.html"
    const val SETTINGS_URL = "$DOMAIN/settings.html"
    const val RECORDS_URL = "$DOMAIN/records.html"

    init {
        // chrome://inspect 远程调试（仅调试构建）
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    fun create(
        context: Context,
        bridge: ShellBridge,
        onFirstPageFinished: (() -> Unit)? = null,
        chooseFiles: ((ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Unit)? = null
    ): WebView {
        // AssetsPathHandler 无 pathPrefix 构造器：包一层把请求映射到 assets/pet/ 子目录
        val assets = WebViewAssetLoader.AssetsPathHandler(context)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.PathHandler { path ->
                assets.handle("pet/$path")
            })
            .build()

        val web = WebView(context)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true // localStorage：设置/台词状态
        // 钉死文字缩放：textZoom 默认跟随系统字体大小（MIUI 大字体=125），
        // 会把全部 CSS 字号放大（气泡 14px→17.5px）。CSS text-size-adjust 管不到
        // textZoom，只能在 native 端钉 100。
        web.settings.textZoom = 100
        web.settings.mediaPlaybackRequiresUserGesture = false
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (chooseFiles == null) return false
                chooseFiles(callback, params)
                return true
            }
        }
        web.setDownloadListener { url, _, _, _, _ -> ShellBridgeHostDefaults.openUrl(context, url) }
        web.setBackgroundColor(Color.TRANSPARENT)
        web.addJavascriptInterface(bridge, "AndroidShell")
        // Blob URLs belong to their creating frame and may be revoked immediately after click.
        if (chooseFiles != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, """
                (() => {
                    const click = HTMLAnchorElement.prototype.click;
                    const save = async anchor => {
                        try {
                            const blob = await (await fetch(anchor.href)).blob();
                            const reader = new FileReader();
                            reader.onload = () => AndroidShell.saveDownload(anchor.download || 'aliya-export.json', blob.type,
                                String(reader.result).split(',')[1]);
                            reader.readAsDataURL(blob);
                        } catch { alert('导出失败，请重试。'); }
                    };
                    HTMLAnchorElement.prototype.click = function() {
                        if (this.download && /^(blob:|data:)/.test(this.href)) { void save(this); return; }
                        return click.call(this);
                    };
                    document.addEventListener('click', event => {
                        const anchor = event.target.closest?.('a[download]');
                        if (anchor && /^(blob:|data:)/.test(anchor.href)) {
                            event.preventDefault(); void save(anchor);
                        }
                    }, true);
                })();
            """.trimIndent(), setOf("*"))
        }
        web.webViewClient = object : WebViewClientCompat() {
            private var firstDone = false

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || request.url.host == "appassets.androidplatform.net") return false
                ShellBridgeHostDefaults.openUrl(context, request.url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (!firstDone) {
                    firstDone = true
                    onFirstPageFinished?.invoke()
                }
            }
        }
        return web
    }
}
