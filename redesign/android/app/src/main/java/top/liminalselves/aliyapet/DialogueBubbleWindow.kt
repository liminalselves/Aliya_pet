package top.liminalselves.aliyapet

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import kotlin.math.roundToInt

/** 独立气泡只加载原有 DOM/CSS，不加载人物、WebGL 或会话计时器。入口均在主线程。 */
internal class DialogueBubbleWindow(private val context: Context, private val wm: WindowManager) {
    private val main = Handler(Looper.getMainLooper())
    private val density get() = context.resources.displayMetrics.density
    private var web: WebView? = null
    private var ready = false
    private var attached = false
    private var destroyed = false
    private var revision = 0
    private var page: JSONObject? = null
    private var contentKey = ""
    private var petX = 0
    private var petY = 0
    private var measured = false
    private var bubbleBottom = 0
    private val params = WindowManager.LayoutParams(
        1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT
    ).apply {
        @Suppress("DEPRECATION")
        gravity = Gravity.TOP or Gravity.LEFT
        alpha = 1f
        title = "Aliya dialogue"
        if (Build.VERSION.SDK_INT >= 28) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    private fun ensureWeb() {
        if (web != null) return
        val view = PetWebViewFactory.create(context, ShellBridge(object : ShellBridge.Host {
            override fun metricsJson() = "{}"
        }))
        web = view
        view.isFocusable = false
        view.isClickable = false
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.addJavascriptInterface(object {
            @JavascriptInterface
            fun ready() {
                main.post {
                    if (destroyed) return@post
                    ready = true
                    contentKey = ""
                    render()
                }
            }
        }, "BubbleHost")
        // 为尚未附着的首帧提供有效视口；真正窗口仍按气泡内容紧贴测量。
        view.layout(0, 0, (280 * density).roundToInt(), (110 * density).roundToInt())
        view.loadUrl("https://appassets.androidplatform.net/bubble.html")
    }

    fun update(json: String, petX: Int, petY: Int) {
        if (destroyed) return
        val next = try { JSONObject(json) } catch (error: org.json.JSONException) {
            Log.e("DialogueBubbleWindow", "Invalid dialogue payload", error)
            hide()
            return
        }
        if (next.optBoolean("closing")) {
            contentKey = ""
            val current = ++revision
            web?.evaluateJavascript("window.__renderDialogueBubble && window.__renderDialogueBubble({closing:true})", null)
            main.postDelayed({ if (!destroyed && revision == current) hide() }, 150)
            return
        }
        if (next.optString("text").isEmpty()) { hide(); return }
        this.petX = petX
        this.petY = petY
        page = next
        ensureWeb()
        web?.onResume()
        render()
    }

    /** 只有文字/适配尺寸/字号变化才重排网页；动作与拖动仅移动现有 Surface。 */
    private fun render() {
        val current = page ?: return
        val view = web ?: return
        if (!ready) return
        val content = JSONObject().apply {
            put("text", current.getString("text"))
            put("viewportWidth", current.optDouble("viewportWidth", 300.0))
            put("viewportHeight", current.optDouble("viewportHeight", 800.0))
            put("font", current.optDouble("font", 20.0))
        }.toString()
        if (content == contentKey && measured) { move(petX, petY); return }
        contentKey = content
        view.onResume()
        val expected = ++revision
        view.evaluateJavascript("window.__renderDialogueBubble($content)") { result ->
            if (destroyed || expected != revision || page == null) return@evaluateJavascript
            val size = try { JSONObject(result) } catch (error: org.json.JSONException) {
                Log.e("DialogueBubbleWindow", "Cannot measure dialogue", error)
                return@evaluateJavascript
            }
            params.width = (size.getDouble("width") * density).roundToInt().coerceAtLeast(1)
            params.height = (size.getDouble("height") * density).roundToInt().coerceAtLeast(1)
            bubbleBottom = (size.getDouble("bottom") * density).roundToInt()
            measured = true
            position()
            if (attached) wm.updateViewLayout(view, params) else {
                try {
                    wm.addView(view, params)
                    attached = true
                } catch (error: RuntimeException) {
                    // 不伪装为已显示，留下可诊断的权限/显示器错误。
                    Log.e("DialogueBubbleWindow", "Cannot add dialogue overlay", error)
                    if (view.parent != null) wm.removeViewImmediate(view)
                }
            }
        }
    }

    fun move(petX: Int, petY: Int) {
        this.petX = petX
        this.petY = petY
        if (!destroyed && attached && position()) wm.updateViewLayout(web, params)
    }

    private fun position(): Boolean {
        val current = page ?: return false
        val width: Int
        val height: Int
        val safeTop: Int
        if (Build.VERSION.SDK_INT >= 30) {
            val metrics = wm.currentWindowMetrics
            width = metrics.bounds.width()
            height = metrics.bounds.height()
            safeTop = metrics.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()
            ).top
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            width = metrics.widthPixels
            height = metrics.heightPixels
            val id = context.resources.getIdentifier("status_bar_height", "dimen", "android")
            safeTop = if (id != 0) context.resources.getDimensionPixelSize(id) else 0
        }
        val x = (petX + current.optDouble("centerX") * density - params.width / 2.0).roundToInt()
            .coerceIn(0, (width - params.width).coerceAtLeast(0))
        val gap = current.optDouble("font", 20.0) * 0.3 * density
        val y = (petY + current.optDouble("headY") * density - bubbleBottom - gap).roundToInt()
            .coerceIn(safeTop, (height - params.height).coerceAtLeast(safeTop))
        if (params.x == x && params.y == y) return false
        params.x = x
        params.y = y
        return true
    }

    fun hide() {
        revision++
        page = null
        contentKey = ""
        web?.evaluateJavascript("window.__renderDialogueBubble && window.__renderDialogueBubble({text:''})", null)
        if (attached) {
            wm.removeViewImmediate(web)
            attached = false
        }
        web?.onPause()
    }

    fun destroy() {
        if (destroyed) return
        hide()
        destroyed = true
        web?.removeJavascriptInterface("BubbleHost")
        web?.destroy()
        web = null
    }
}
