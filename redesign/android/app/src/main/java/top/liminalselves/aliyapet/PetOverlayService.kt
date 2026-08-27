package top.liminalselves.aliyapet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * 悬浮窗模式：前台服务 + WindowManager 透明 WebView。
 *
 * 拖动走悬浮窗标准方案：壳侧 OnTouchListener 超阈值后按 rawX/rawY 直接
 * updateViewLayout 搬运窗口（聊天头同款），全程不进 JS——没有 IPC 延迟、
 * 没有量化跳格，手指永远压在窗口上（触摸流不被下层抢走）。
 * 点击/抚摸仍交给前端（DOWN 先放行，未超阈值的事件流完整留给 WebView）。
 *
 * 内容贴合窗口：前端逐帧下发包裹角色剪影的窗口矩形（setWindowRect），
 * 透明区域不属于任何窗口 → 触摸天然穿透到下层应用；
 * FLAG_LAYOUT_NO_LIMITS 允许角色半出屏（前端有 48px 防丢钳制）。
 */
class PetOverlayService : android.app.Service(), ShellBridge.Host {

    companion object {
        private const val CHANNEL_ID = "pet_overlay"
        private const val NOTIF_ID = 1001
        private const val ACTION_QUIT = "top.liminalselves.aliyapet.QUIT"
        private const val ACTION_OPEN = "top.liminalselves.aliyapet.OPEN"

        /** 前端窗口基准（CSS px）：高 796.5 = 675×1.18，宽 = 高×0.64（包围盒比例）。 */
        private const val BASE_H_CSS = 796.5f
        private const val BASE_ASPECT = 0.64f

        /** 透明区穿透后恢复可触摸的延迟（ms）：覆盖一次点按/滑动手势时长。 */
        private const val PASS_THROUGH_MS = 350L

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, PetOverlayService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PetOverlayService::class.java))
        }
    }

    private lateinit var web: WebView
    private lateinit var params: WindowManager.LayoutParams
    private val wm: WindowManager
        get() = getSystemService(WINDOW_SERVICE) as WindowManager
    private val density: Float
        get() = resources.displayMetrics.density

    // ---------- 原生拖动 ----------
    /** 拖动进行中：窗口由壳搬运，前端 setWindowRect 一律忽略。 */
    @Volatile private var nativeDragging = false
    /** 前端手势是抚摸/命中互动（DOWN 落在头部抚摸区或互动区）：壳不得拖动。 */
    @Volatile private var jsInteracting = false
    private var dragPointerId = -1
    private var dragStartRawX = 0f
    private var dragStartRawY = 0f
    private var dragStartParamX = 0
    private var dragStartParamY = 0
    private val touchSlop by lazy { ViewConfiguration.get(this).scaledTouchSlop }

    // ---------- 像素掩码穿透 ----------
    /** 前端上报的占用掩码（0/1，覆盖整个窗口）：DOWN 命中透明格 → 本手势穿透给下层。 */
    @Volatile private var maskCols = 0
    @Volatile private var maskRows = 0
    @Volatile private var maskData: ByteArray? = null
    /** 穿透期间忽略 DOWN 命中测试（窗口本就收不到，保险）。 */
    @Volatile private var passThrough = false
    /** 窗外触摸上报节流（视线跟随）。 */
    private var lastOutsideTouchMs = 0L

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    web.onPause() // 暂停 WebView 渲染与 JS 定时器
                    evalShellEvent("screen-off")
                }
                Intent.ACTION_SCREEN_ON -> {
                    web.onResume()
                    evalShellEvent("screen-on")
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 无悬浮窗权限直接退出：addView 会抛异常把服务打挂（BootReceiver 自启路径也会走到这里）
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return
        }
        createChannel()

        val screenW = screenPhysical().first
        val screenH = screenPhysical().second
        // 默认尺寸：屏幕高的 45%（前端加载后会按 scale 设置精确尺寸）
        val winHCss = screenH / density * 0.45f
        val winWCss = winHCss * BASE_ASPECT
        var w = (winWCss * density).roundToInt()
        var h = (winHCss * density).roundToInt()

        web = PetWebViewFactory.create(this, ShellBridge(this))
        attachNativeDrag()
        params = WindowManager.LayoutParams(
            w, h,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                // 允许窗口整个拖出屏幕（用户明确要求全域停靠）
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                // 窗外触摸以 ACTION_OUTSIDE 上报（视线跟随到触点）
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                // 悬浮窗窗口默认软件渲染，WebGL 会输出空白，必须显式开启硬件加速
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP or Gravity.START
        val saved = ShellPrefs.getPetPos(this)
        if (saved != null) {
            // petX/petY 是角色原点（非窗口左上角）：按原点居中估算初始矩形，
            // 前端加载完成后会逐帧下发精确剪影矩形
            params.x = (saved.first * density).roundToInt() - w / 2
            params.y = (saved.second * density).roundToInt() - (h * 0.55f).roundToInt()
        } else {
            params.x = (screenW - w - (16 * density).roundToInt()).coerceAtLeast(0)
            params.y = (screenH * 0.25f).roundToInt()
        }
        w = w.coerceAtMost(screenW); h = h.coerceAtMost(screenH)
        params.width = w; params.height = h
        wm.addView(web, params)

        registerReceiver(screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        })

        web.loadUrl(PetWebViewFactory.PET_URL)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_QUIT -> {
                stopSelf()
                // 用户明确退出：清掉后台进程（Activity 可能还挂在最近任务）
                android.os.Process.killProcess(android.os.Process.myPid())
                return START_NOT_STICKY
            }
            ACTION_OPEN -> {
                val i = Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                try {
                    startActivity(i)
                } catch (_: Exception) {
                }
                stopSelf()
                return START_NOT_STICKY
            }
        }
        startForeground(NOTIF_ID, buildNotification())
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(screenReceiver)
        } catch (_: Exception) {
        }
        try {
            wm.removeView(web)
        } catch (_: Exception) {
        }
        web.destroy()
        super.onDestroy()
    }

    // ---------- 通知 ----------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.overlay_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = getString(R.string.overlay_channel_desc) }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val openPi = PendingIntent.getService(
            this, 0,
            Intent(this, PetOverlayService::class.java).setAction(ACTION_OPEN),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val quitPi = PendingIntent.getService(
            this, 1,
            Intent(this, PetOverlayService::class.java).setAction(ACTION_QUIT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val contentPi = PendingIntent.getActivity(
            this, 2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_pet_foreground)
            .setContentTitle(getString(R.string.overlay_notif_title))
            .setContentText(getString(R.string.overlay_notif_text))
            .setContentIntent(contentPi)
            .addAction(0, getString(R.string.act_open), openPi)
            .addAction(0, getString(R.string.act_quit), quitPi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    // ---------- ShellBridge.Host ----------

    override fun setInteracting(interacting: Boolean) {
        jsInteracting = interacting
    }

    /**
     * 原生拖动（悬浮窗标准方案）+ 透明区穿透 + 窗外触摸：
     * DOWN 先过像素掩码：透明 → 本手势切 NOT_TOUCHABLE 穿透给下层；
     * 不透明 → 放行给 WebView（点击/抚摸）；位移超 touchSlop 且前端未声明
     * 互动手势时壳接管：按 raw 位移直接 updateViewLayout，事件不再透给 WebView；
     * UP/CANCEL 结束并把总位移（CSS px）回传前端做吸附/持久化。
     * ACTION_OUTSIDE（窗外触摸）节流上报前端做视线跟随。
     */
    private fun attachNativeDrag() {
        web.setOnTouchListener listener@{ _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (isTransparentAt(ev.x, ev.y)) {
                        // 角色透明区：本手势穿透到下层应用（延迟恢复可触摸）
                        passThrough = true
                        setTouchable(false)
                        web.postDelayed({
                            passThrough = false
                            setTouchable(true)
                        }, PASS_THROUGH_MS)
                        return@listener true
                    }
                    dragPointerId = ev.getPointerId(0)
                    dragStartRawX = ev.rawX
                    dragStartRawY = ev.rawY
                    dragStartParamX = params.x
                    dragStartParamY = params.y
                    nativeDragging = false
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    if (ev.findPointerIndex(dragPointerId) < 0) {
                        false
                    } else {
                        val dx = ev.rawX - dragStartRawX
                        val dy = ev.rawY - dragStartRawY
                        if (!nativeDragging &&
                            !jsInteracting &&
                            dx * dx + dy * dy > touchSlop * touchSlop
                        ) {
                            // 抢走手势前补发 CANCEL 给 WebView：DOWN 已透传给前端，
                            // 若不补 CANCEL，JS 的 pointerdown（抚摸按下）永远收不到
                            // 配对结束，petting/interacting 状态卡死。须在 nativeDragging
                            // 置 true 之前发——否则后续分支返回 true 会把 CANCEL 也吞掉。
                            val cancel = MotionEvent.obtain(ev)
                            cancel.action = MotionEvent.ACTION_CANCEL
                            web.dispatchTouchEvent(cancel)
                            cancel.recycle()
                            nativeDragging = true
                            evalJs("window.__pet && window.__pet.onNativeDragStart && window.__pet.onNativeDragStart();")
                        }
                        if (nativeDragging) {
                            // 全域停靠：窗口可整个拖出屏幕（用户明确要求）；
                            // 钳到「完全出屏」域仅防 WM 参数溢出，找回走设置页重置位置
                            val (sw, sh) = screenPhysical()
                            params.x = (dragStartParamX + dx.roundToInt())
                                .coerceIn(-params.width, sw)
                            params.y = (dragStartParamY + dy.roundToInt())
                                .coerceIn(-params.height, sh)
                            wm.updateViewLayout(web, params)
                            true
                        } else {
                            false
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (nativeDragging) {
                        nativeDragging = false
                        val dxCss = (params.x - dragStartParamX) / density
                        val dyCss = (params.y - dragStartParamY) / density
                        evalJs("window.__pet && window.__pet.onNativeDragEnd && window.__pet.onNativeDragEnd($dxCss, $dyCss);")
                        true
                    } else {
                        false
                    }
                }
                MotionEvent.ACTION_OUTSIDE -> {
                    // 窗外触摸（桌面任意处点按）：上报前端，角色视线跟到触点
                    val now = android.os.SystemClock.uptimeMillis()
                    if (now - lastOutsideTouchMs > 120) {
                        lastOutsideTouchMs = now
                        val xCss = ev.rawX / density
                        val yCss = ev.rawY / density
                        evalJs("window.__pet && window.__pet.onOutsideTouch && window.__pet.onOutsideTouch($xCss, $yCss);")
                    }
                    false
                }
                else -> false
            }
        }
    }

    /** 事件坐标（窗口内物理 px）是否落在角色透明像素上。无掩码时保守视为不透明。 */
    private fun isTransparentAt(xPhys: Float, yPhys: Float): Boolean {
        if (passThrough) return false
        val cols = maskCols
        val rows = maskRows
        val data = maskData
        if (cols <= 0 || rows <= 0 || data == null ||
            params.width <= 0 || params.height <= 0
        ) {
            return false
        }
        val gx = (xPhys / params.width * cols).toInt().coerceIn(0, cols - 1)
        val gy = (yPhys / params.height * rows).toInt().coerceIn(0, rows - 1)
        return data[gy * cols + gx].toInt() == 0
    }

    /** 切换窗口可触摸性（透明区穿透用）。 */
    private fun setTouchable(touchable: Boolean) {
        val f = if (touchable) {
            params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        } else {
            params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        if (f == params.flags) return
        params.flags = f
        try {
            wm.updateViewLayout(web, params)
        } catch (_: Exception) {
        }
    }

    override fun metricsJson(): String {
        // 只读缓存状态，可在 JavaBridge 线程同步调用
        val (sw, sh) = screenPhysical()
        val d = density
        val m = JSONObject()
        m.put("density", d.toDouble())
        m.put("screenW", (sw / d).toDouble())
        m.put("screenH", (sh / d).toDouble())
        m.put("winX", (params.x / d).toDouble())
        m.put("winY", (params.y / d).toDouble())
        m.put("winW", (params.width / d).toDouble())
        m.put("winH", (params.height / d).toDouble())
        return m.toString()
    }

    override fun getMode(): String = "overlay"

    override fun setWindowRect(xCss: Float, yCss: Float, wCss: Float, hCss: Float) {
        if (nativeDragging) return // 原生拖动期间窗口由壳独占
        val w = (wCss * density).roundToInt().coerceAtLeast(8)
        val h = (hCss * density).roundToInt().coerceAtLeast(8)
        // 固定窗口架构：矩形由前端按静态包围盒一次算定，壳不再钳制——
        // 窗口可随拖动整个出屏（NO_LIMITS），吸附归位由前端缓动驱动
        params.x = (xCss * density).roundToInt()
        params.y = (yCss * density).roundToInt()
        params.width = w
        params.height = h
        wm.updateViewLayout(web, params)
        // 位置持久化在前端（petX/petY 现在指角色原点而非窗口左上角）
    }

    /** 前端上报像素占用掩码（0/1 字符串，cols×rows 覆盖整个窗口）。 */
    override fun setHitMask(cols: Int, rows: Int, data: String) {
        if (cols <= 0 || rows <= 0 || data.length != cols * rows) return
        maskCols = cols
        maskRows = rows
        maskData = ByteArray(data.length) { if (data[it] == '1') 1 else 0 }
    }

    override fun moveWindowBy(dxCss: Float, dyCss: Float) {
        params.x += (dxCss * density).roundToInt()
        params.y += (dyCss * density).roundToInt()
        wm.updateViewLayout(web, params)
    }

    override fun setWindowSize(wCss: Float, hCss: Float) {
        params.width = (wCss * density).roundToInt().coerceAtLeast(8)
        params.height = (hCss * density).roundToInt().coerceAtLeast(8)
        wm.updateViewLayout(web, params)
    }

    override fun setWindowPos(xCss: Float, yCss: Float) {
        params.x = (xCss * density).roundToInt()
        params.y = (yCss * density).roundToInt()
        wm.updateViewLayout(web, params)
    }

    override fun openUrl(url: String) = ShellBridgeHostDefaults.openUrl(this, url)
    override fun isOverlayGranted(): Boolean = Settings.canDrawOverlays(this)
    override fun setAutoStart(on: Boolean) = ShellPrefs.setAutoStart(this, on)
    override fun isAutoStart(): Boolean = ShellPrefs.getAutoStart(this)
    override fun setPref(key: String, value: String) = ShellPrefs.setPref(this, key, value)
    override fun getPref(key: String): String = ShellPrefs.getPref(this, key)

    override fun shellAction(action: String) {
        when (action) {
            "open-main" -> {
                val i = Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                try {
                    startActivity(i)
                } catch (_: Exception) {
                }
                stopSelf()
            }
            "hide-overlay", "exit" -> {
                stopSelf()
                if (action == "exit") {
                    android.os.Process.killProcess(android.os.Process.myPid())
                }
            }
            "open-overlay-settings" -> ShellBridgeHostDefaults.openOverlaySettings(this)
        }
    }

    // ---------- 工具 ----------

    /** 物理像素屏幕尺寸（API 30+ 用 WindowMetrics，低版本回退 getRealMetrics）。 */
    private fun screenPhysical(): Pair<Int, Int> {
        return if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            Pair(b.width(), b.height())
        } else {
            @Suppress("DEPRECATION")
            val dm = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            Pair(dm.widthPixels, dm.heightPixels)
        }
    }

    private fun evalShellEvent(event: String) {
        web.evaluateJavascript(
            "window.__pet && window.__pet.onShellEvent('$event');", null
        )
    }

    private fun evalJs(js: String) {
        try {
            web.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
    }
}
