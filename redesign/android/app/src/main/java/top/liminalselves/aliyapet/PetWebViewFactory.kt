package top.liminalselves.aliyapet

import android.content.Context
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

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

    init {
        // chrome://inspect 远程调试（仅调试构建）
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    fun create(
        context: Context,
        bridge: ShellBridge,
        onFirstPageFinished: (() -> Unit)? = null
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
        web.setBackgroundColor(Color.TRANSPARENT)
        web.addJavascriptInterface(bridge, "AndroidShell")
        web.webViewClient = object : WebViewClientCompat() {
            private var firstDone = false

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

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
