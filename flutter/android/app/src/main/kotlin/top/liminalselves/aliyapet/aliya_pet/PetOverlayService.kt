package top.liminalselves.aliyapet.aliya_pet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.WindowManager
import io.flutter.embedding.android.FlutterView
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.embedding.engine.loader.FlutterLoader
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.GeneratedPluginRegistrant

/**
 * 桌面宠物悬浮窗前台服务。
 *
 * 悬浮窗承载独立 FlutterEngine（Dart entrypoint: overlayMain），
 * 内部渲染 Live2D 模型。
 *
 * 触摸事件全部透传给 Flutter（抚摸/捏合缩放/点击在 Dart 侧处理）；
 * 窗口移动与尺寸调整由 Dart 侧经 [CHANNEL_OVERLAY] 通道驱动：
 * - "resize"：缩放时调整窗口物理尺寸（updateViewLayout）；
 * - "moveBy"：拖动手柄产生的位移增量（物理像素）；
 * - "getScreenSize"：屏幕物理尺寸（Dart 推导缩放范围用）；
 * - "close"：关闭悬浮窗。
 */
class PetOverlayService : Service() {

    private var windowManager: WindowManager? = null
    private var overlayView: FlutterView? = null
    private var engine: FlutterEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                if (!isRunning) startOverlay()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        isRunning = false
        controlChannel = null
        removeOverlay()
        super.onDestroy()
    }

    // ---------- 悬浮窗 ----------

    private fun startOverlay() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        windowManager = wm
        startForeground(NOTIFICATION_ID, buildNotification())

        val engine = createFlutterEngine()
        this.engine = engine
        val view = FlutterView(this)
        view.attachToFlutterEngine(engine)
        overlayView = view

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        // 初始尺寸仅是占位：Dart 启动后会按保存的 scale 经 "resize" 校准。
        val params = WindowManager.LayoutParams(
            INITIAL_WIDTH,
            INITIAL_HEIGHT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 120
        }

        // 触摸事件不在原生侧拦截：全部透传 Flutter（抚摸/捏合/点击），
        // 窗口拖动由 Dart 侧拖动手柄经 "moveBy" 通道驱动。
        // （不在 FlutterView 上设置 OnTouchListener。）

        try {
            wm.addView(view, params)
            isRunning = true
        } catch (e: Exception) {
            // 权限缺失或系统限制
            engine.destroy()
            this.engine = null
            overlayView = null
        }
    }

    private fun removeOverlay() {
        overlayView?.let { v ->
            runCatching { windowManager?.removeView(v) }
            overlayView = null
        }
        engine?.let { e ->
            FlutterEngineCache.getInstance().remove("pet_overlay")
            e.destroy()
            engine = null
        }
    }

    /** 缩放时调整悬浮窗物理尺寸；尺寸未变时跳过（避免无效布局抖动）。 */
    private fun resizeOverlay(width: Int, height: Int): Boolean {
        val view = overlayView ?: return false
        val wm = windowManager ?: return false
        if (width < MIN_WINDOW_PX || height < MIN_WINDOW_PX) return false
        val params = view.layoutParams as WindowManager.LayoutParams
        if (params.width == width && params.height == height) return true
        params.width = width
        params.height = height
        return runCatching { wm.updateViewLayout(view, params) }.isSuccess
    }

    /** 拖动手柄驱动的窗口位移（物理像素增量）。 */
    private fun moveBy(dx: Int, dy: Int) {
        val view = overlayView ?: return
        val wm = windowManager ?: return
        val params = view.layoutParams as WindowManager.LayoutParams
        params.x += dx
        params.y += dy
        runCatching { wm.updateViewLayout(view, params) }
    }

    // ---------- Flutter 引擎 ----------

    private fun createFlutterEngine(): FlutterEngine {
        val e = FlutterEngine(this)
        FlutterEngineCache.getInstance().put("pet_overlay", e)

        val flutterLoader = FlutterLoader()
        flutterLoader.startInitialization(this)
        flutterLoader.ensureInitializationComplete(this, null)

        val entrypoint = DartExecutor.DartEntrypoint(
            flutterLoader.findAppBundlePath(),
            "overlayMain"
        )
        e.dartExecutor.executeDartEntrypoint(entrypoint)
        // 关键：Service 无 Activity 驱动 lifecycle，引擎默认 detached 会暂停帧调度（UI 冻结、Ticker 不触发），
        // 必须显式置为 resumed 才能持续渲染。
        e.lifecycleChannel.appIsResumed()
        GeneratedPluginRegistrant.registerWith(e)

        // 悬浮窗控制通道：接收 Dart 侧调用；同时用于主 App 反向通知（reloadSettings）。
        val channel = MethodChannel(e.dartExecutor.binaryMessenger, CHANNEL_OVERLAY)
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "close" -> {
                    stopSelf()
                    result.success(null)
                }
                "resize" -> {
                    val w = call.argument<Int>("width") ?: 0
                    val h = call.argument<Int>("height") ?: 0
                    result.success(resizeOverlay(w, h))
                }
                "moveBy" -> {
                    val dx = call.argument<Int>("dx") ?: 0
                    val dy = call.argument<Int>("dy") ?: 0
                    moveBy(dx, dy)
                    result.success(null)
                }
                "getScreenSize" -> {
                    val dm = resources.displayMetrics
                    result.success(
                        mapOf("width" to dm.widthPixels, "height" to dm.heightPixels)
                    )
                }
                else -> result.notImplemented()
            }
        }
        controlChannel = channel
        return e
    }

    // ---------- 通知 ----------

    private fun buildNotification(): Notification {
        val channelId = "aliya_pet_overlay"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "桌面宠物", NotificationManager.IMPORTANCE_LOW
            )
            nm.createNotificationChannel(channel)
        }

        val stopIntent = PendingIntent.getService(
            this, 0,
            Intent(this, PetOverlayService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Aliya 桌面宠物")
            .setContentText("宠物正在桌面上陪伴你")
            .setSmallIcon(android.R.drawable.ic_menu_myplaces)
            .setContentIntent(stopIntent)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_START = "top.liminalselves.aliyapet.overlay.START"
        const val ACTION_STOP = "top.liminalselves.aliyapet.overlay.STOP"
        const val CHANNEL_OVERLAY = "top.liminalselves.aliyapet/overlay_control"
        private const val NOTIFICATION_ID = 7
        private const val INITIAL_WIDTH = 420
        private const val INITIAL_HEIGHT = 640
        private const val MIN_WINDOW_PX = 120

        /** 悬浮窗引擎的控制通道（主 App 设置变更时反向通知用）。 */
        @Volatile
        private var controlChannel: MethodChannel? = null

        /** 主 App 设置变更（scale/镜像/自动动作）→ 通知悬浮窗重新加载设置。 */
        fun notifySettingsChanged() {
            controlChannel?.invokeMethod("reloadSettings", null)
        }

        @Volatile
        var isRunning = false
            private set
    }
}
