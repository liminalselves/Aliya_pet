package top.liminalselves.aliyapet

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * 前端 ↔ 壳桥（addJavascriptInterface 注入为 window.AndroidShell）。
 *
 * JS Interface 方法运行在 WebView 的 "JavaBridge" 线程；窗口操作必须回主线程。
 * getMetrics() 保持同步返回（仅读不可变/缓存状态），前端是同步调用语义。
 * 单位约定：所有窗口坐标/尺寸均为 CSS px，Host 实现内部乘 density 换算物理像素。
 */
class ShellBridge(private val host: Host) {

    interface Host {
        /** 窗口/屏幕度量（CSS px），JSON：density, screenW, screenH, winX, winY, winW, winH。 */
        fun metricsJson(): String

        fun moveWindowBy(dxCss: Float, dyCss: Float) {}
        fun setWindowSize(wCss: Float, hCss: Float) {}
        fun setWindowPos(xCss: Float, yCss: Float) {}

        /** 原子设置窗口矩形（CSS px）：内容贴合模式下前端逐帧下发。 */
        fun setWindowRect(xCss: Float, yCss: Float, wCss: Float, hCss: Float) {}

        /** 窗口平滑平移到 (x,y)（CSS px），原生动画按刷新率驱动；结束回调前端 onNativeSnapEnd。 */
        fun animateWindowTo(xCss: Float, yCss: Float, durationMs: Int) {}

        /** activity=App 内全屏；overlay=悬浮窗（前端据此切换内容贴合渲染）。 */
        fun getMode(): String = "activity"

        fun openUrl(url: String) {}
        /** 悬浮窗权限是否已授予（设置页状态行）。 */
        fun isOverlayGranted(): Boolean = true
        fun setAutoStart(on: Boolean) {}
        fun isAutoStart(): Boolean = false
        fun setPref(key: String, value: String) {}
        fun getPref(key: String): String = ""

        /** open-main / open-settings / hide-overlay / exit。 */
        fun shellAction(action: String) {}

        /**
         * 前端手势状态（悬浮窗原生拖动仲裁用）：
         * true=当前手势是抚摸/命中互动（壳不得拖动窗口）；false=壳可接管拖动。
         * 实现必须直接落 volatile——不能切主线程，否则手势竞态窗口内状态过期。
         */
        fun setInteracting(interacting: Boolean) {}

        /**
         * 像素占用掩码（0/1 字符串，cols×rows 覆盖整个窗口）：
         * Android 13+ 壳在输入分发前设置 TouchableRegion；旧版仅临时切换 NOT_TOUCHABLE，
         * 无法重新分发已经收到的首个 DOWN。实现直接落 volatile（JavaBridge 线程调用，UI 线程读）。
         */
        fun setHitMask(cols: Int, rows: Int, data: String) {}

        /** 独立原生气泡：文本、人物窗口内锚点及 CSS 样式；空文本隐藏。 */
        fun setDialogueBubble(json: String) {}

        /** 设置页全量设置 JSON：壳转发给桌宠 WebView 实时应用。 */
        fun notifySettings(json: String) {}

        /** 设置页动作 JSON（tray-action 形状）：壳转发给桌宠 WebView 执行。 */
        fun notifyPetAction(json: String) {}
        fun saveDownload(name: String, mime: String, base64: String) {}

    }

    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun getMetrics(): String = host.metricsJson()

    @JavascriptInterface
    fun moveWindowBy(dx: Float, dy: Float) {
        main.post { host.moveWindowBy(dx, dy) }
    }

    @JavascriptInterface
    fun setWindowSize(w: Float, h: Float) {
        main.post { host.setWindowSize(w, h) }
    }

    @JavascriptInterface
    fun setWindowPos(x: Float, y: Float) {
        main.post { host.setWindowPos(x, y) }
    }

    @JavascriptInterface
    fun setWindowRect(x: Float, y: Float, w: Float, h: Float) {
        main.post { host.setWindowRect(x, y, w, h) }
    }

    @JavascriptInterface
    fun animateWindowTo(x: Float, y: Float, durationMs: Int) {
        main.post { host.animateWindowTo(x, y, durationMs) }
    }

    @JavascriptInterface
    fun getMode(): String = host.getMode()

    @JavascriptInterface
    fun openUrl(url: String) {
        main.post { host.openUrl(url) }
    }

    @JavascriptInterface
    fun isOverlayGranted(): Boolean = host.isOverlayGranted()

    @JavascriptInterface
    fun setAutoStart(on: Boolean) {
        host.setAutoStart(on)
    }

    @JavascriptInterface
    fun isAutoStart(): Boolean = host.isAutoStart()

    @JavascriptInterface
    fun setPref(key: String, value: String) {
        host.setPref(key, value)
    }

    @JavascriptInterface
    fun getPref(key: String): String = host.getPref(key)

    @JavascriptInterface
    fun shellAction(action: String) {
        main.post { host.shellAction(action) }
    }

    @JavascriptInterface
    fun setInteracting(interacting: Boolean) {
        // 手势仲裁状态： JavaBridge 线程直写，不 post（见 Host.setInteracting）
        host.setInteracting(interacting)
    }

    @JavascriptInterface
    fun setHitMask(cols: Int, rows: Int, data: String) {
        // 命中掩码：JavaBridge 线程直写 volatile，UI 线程在 DOWN 时读
        host.setHitMask(cols, rows, data)
    }

    @JavascriptInterface
    fun setDialogueBubble(json: String) {
        main.post { host.setDialogueBubble(json) }
    }

    @JavascriptInterface
    fun notifySettings(json: String) {
        main.post { host.notifySettings(json) }
    }

    @JavascriptInterface
    fun saveDownload(name: String, mime: String, base64: String) {
        main.post { host.saveDownload(name, mime, base64) }
    }

    @JavascriptInterface
    fun notifyPetAction(json: String) {
        main.post { host.notifyPetAction(json) }
    }

}
