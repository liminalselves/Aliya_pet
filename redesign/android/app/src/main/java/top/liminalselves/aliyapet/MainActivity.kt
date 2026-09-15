package top.liminalselves.aliyapet

import android.Manifest
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

/**
 * App 内模式：全屏 WebView 桌宠 + 右上角圆形菜单按钮（底部弹出菜单）。
 * 退到后台（onStop）时若已授权悬浮窗且开关开启，自动转 PetOverlayService。
 */
class MainActivity : AppCompatActivity(), ShellBridge.Host {

    private lateinit var web: android.webkit.WebView
    private lateinit var root: FrameLayout
    private lateinit var menuBtn: android.widget.ImageButton

    /** 设置页独立 WebView：覆盖在桌宠页上滑入滑出，返回时桌宠不重建。 */
    private var settingsWeb: android.webkit.WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val density = resources.displayMetrics.density
        root = FrameLayout(this)
        // 首开淡入：模型加载有几秒白屏期，淡入盖住生硬的突然出现
        web = PetWebViewFactory.create(this, ShellBridge(this)) {
            web.animate().alpha(1f).setDuration(350).start()
        }
        web.alpha = 0f
        root.addView(
            web,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        // 圆形半透明悬浮按钮（⋮）
        menuBtn = android.widget.ImageButton(this).apply {
            setImageResource(R.drawable.ic_menu_dots)
            scaleType = android.widget.ImageView.ScaleType.CENTER
            setPadding(0, 0, 0, 0)
            minimumWidth = 0
            minimumHeight = 0
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.fab_circle)
            // 圆形涟漪点击反馈
            val tv = android.util.TypedValue()
            theme.resolveAttribute(
                android.R.attr.selectableItemBackgroundBorderless, tv, true
            )
            if (tv.resourceId != 0) {
                foreground = ContextCompat.getDrawable(this@MainActivity, tv.resourceId)
            }
            stateListAnimator = null
            alpha = 0.75f
            contentDescription = getString(R.string.menu_settings)
            setOnClickListener { showMenuSheet() }
        }
        val fabSize = (44 * density).roundToInt()
        val fabMargin = (14 * density).roundToInt()
        root.addView(
            menuBtn,
            FrameLayout.LayoutParams(fabSize, fabSize, Gravity.TOP or Gravity.END).apply {
                topMargin = fabMargin
                rightMargin = fabMargin
                marginEnd = fabMargin
            }
        )
        setContentView(root)

        // 系统栏遮挡：内容整体避让状态栏/手势条（边缘到边缘布局下
        // 根布局绘制到栏后，栏区显示渐变背景，内容区不被遮挡）
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars()
            )
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        // 浅色背景配深色系统栏图标；去掉系统对比度遮罩（栏区透出自己的渐变背景）
        androidx.core.view.WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        @Suppress("DEPRECATION")
        run {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
        }

        // 返回键：设置页开着 → 滑出关闭；桌宠页 → 退后台（触发悬浮窗）
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (settingsWeb != null) {
                    closeSettings()
                } else {
                    moveTaskToBack(true)
                }
            }
        })

        web.loadUrl(PetWebViewFactory.PET_URL)

        // Android 13+：前台服务通知需要通知权限
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
        handleMiauthIntent(intent)
    }

    /** 浏览器授权回跳（aliyapet://miauth/?session=...）写入壳侧偏好，前端轮询取走后完成换 token。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleMiauthIntent(intent)
    }

    private fun handleMiauthIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "aliyapet" || data.host != "miauth") return
        val query = data.encodedQuery ?: return
        // SharedPreferences 持久保存：冷启动页面未加载完也不丢，前端就绪后轮询自取。
        ShellPrefs.setPref(this, "miauth_callback", query)
    }

    override fun onStart() {
        super.onStart()
        // 回到前台：撤掉悬浮窗（两个容器不同 WebView，避免双宠物）
        PetOverlayService.stop(this)
    }

    override fun onPause() {
        super.onPause()
        // 退后台即刻拉起悬浮窗服务（onStop 会晚几百毫秒，观感慢半拍）；
        // 服务内创建 WebView 需要数百毫秒，越早开始桌宠出现得越快
        if (ShellPrefs.getOverlayOnExit(this) && Settings.canDrawOverlays(this)) {
            PetOverlayService.start(this)
        }
    }

    override fun onStop() {
        super.onStop()
        // onPause 已拉起时这里是重复 start（服务幂等），仅作兜底
        if (ShellPrefs.getOverlayOnExit(this) && Settings.canDrawOverlays(this)) {
            PetOverlayService.start(this)
        }
    }

    /**
     * 打开设置页：独立 WebView 从右侧滑入覆盖桌宠页。
     * 桌宠 WebView 保持加载状态，返回时零重建（旧方案 loadUrl 来回切换，
     * 每次返回都要重载 WebGL+模型，肉眼可见地卡一下）。
     */
    private fun openSettings(hash: String = "") {
        settingsWeb?.let {
            // 已打开（如菜单里点「关于」）：只切锚点
            it.loadUrl("${PetWebViewFactory.SETTINGS_URL}$hash")
            return
        }
        val sw = PetWebViewFactory.create(this, ShellBridge(this))
        sw.setBackgroundColor(android.graphics.Color.WHITE) // 滑入途中不透出下层
        root.addView(
            sw,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        settingsWeb = sw
        val w = if (root.width > 0) root.width.toFloat()
        else resources.displayMetrics.widthPixels.toFloat()
        sw.translationX = w
        sw.animate()
            .translationX(0f)
            .setDuration(260)
            .setInterpolator(android.view.animation.DecelerateInterpolator(1.6f))
            .start()
        sw.loadUrl("${PetWebViewFactory.SETTINGS_URL}$hash")
        // 设置页不显示右上角菜单按钮
        menuBtn.animate().cancel()
        menuBtn.animate()
            .alpha(0f)
            .setDuration(160)
            .withEndAction { menuBtn.visibility = View.GONE }
            .start()
    }

    /** 关闭设置页：向右滑出后销毁，桌宠页原样露出。 */
    private fun closeSettings() {
        val sw = settingsWeb ?: return
        settingsWeb = null // 立即置空，防止动画期间重复触发
        val w = if (root.width > 0) root.width.toFloat()
        else resources.displayMetrics.widthPixels.toFloat()
        sw.animate().cancel()
        sw.animate()
            .translationX(w)
            .setDuration(210)
            .setInterpolator(android.view.animation.AccelerateInterpolator(1.3f))
            .withEndAction {
                root.removeView(sw)
                sw.destroy()
            }
            .start()
        menuBtn.animate().cancel()
        menuBtn.visibility = View.VISIBLE
        menuBtn.animate().alpha(0.75f).setDuration(160).start()
    }

    /** 底部弹出菜单：设置 / 悬浮窗模式 / 关于 / 退出。 */
    private fun showMenuSheet() {
        val dlg = Dialog(this, R.style.MenuSheetDialog)
        val view = layoutInflater.inflate(R.layout.menu_sheet, null) as MenuSheetLayout
        // 避让系统导航栏：手势条/三键栏会盖住最后的「退出」项
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars()
            )
            val base = (12 * resources.displayMetrics.density).roundToInt()
            v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, base + bars.bottom)
            insets
        }
        dlg.setContentView(view)
        // 下拉滑出关闭（MenuSheetLayout 完成位移动画后回调）
        view.onDismissed = { dlg.dismiss() }
        dlg.show()
        dlg.window?.apply {
            // 内容延伸到导航栏区域，让菜单白底盖住手势条/三键栏背后的空隙
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(this, false)
            setGravity(Gravity.BOTTOM)
            setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = 0.35f }
            // 导航栏与菜单底色一致（近白），避免底部一条黑边
            @Suppress("DEPRECATION")
            run {
                navigationBarColor = android.graphics.Color.WHITE
                isNavigationBarContrastEnforced = false
            }
            androidx.core.view.WindowInsetsControllerCompat(this, view)
                .isAppearanceLightNavigationBars = true
        }
        view.findViewById<View>(R.id.menu_settings).setOnClickListener {
            dlg.dismiss()
            openSettings()
        }
        view.findViewById<View>(R.id.menu_overlay).setOnClickListener {
            dlg.dismiss()
            enterOverlay()
        }
        view.findViewById<View>(R.id.menu_about).setOnClickListener {
            dlg.dismiss()
            openSettings("#about")
        }
        view.findViewById<View>(R.id.menu_quit).setOnClickListener {
            dlg.dismiss()
            PetOverlayService.stop(this)
            finishAndRemoveTask()
        }
    }

    /** 进入悬浮窗模式：已授权则退到后台（onStop 自动拉起服务），否则引导授权。 */
    private fun enterOverlay() {
        if (Settings.canDrawOverlays(this)) {
            moveTaskToBack(true)
        } else {
            Toast.makeText(this, R.string.toast_need_overlay_permission, Toast.LENGTH_LONG)
                .show()
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
            )
        }
    }

    // ---------- ShellBridge.Host：App 内为全屏容器，窗口操作全部空实现 ----------

    override fun metricsJson(): String {
        val dm = resources.displayMetrics
        val d = dm.density
        val w = dm.widthPixels / d
        val h = dm.heightPixels / d
        return "{\"density\":$d,\"screenW\":$w,\"screenH\":$h," +
            "\"winX\":0,\"winY\":0,\"winW\":$w,\"winH\":$h}"
    }

    override fun openUrl(url: String) = ShellBridgeHostDefaults.openUrl(this, url)
    override fun isOverlayGranted(): Boolean = Settings.canDrawOverlays(this)
    override fun setAutoStart(on: Boolean) = ShellPrefs.setAutoStart(this, on)
    override fun isAutoStart(): Boolean = ShellPrefs.getAutoStart(this)
    override fun setPref(key: String, value: String) = ShellPrefs.setPref(this, key, value)
    override fun getPref(key: String): String = ShellPrefs.getPref(this, key)

    /** 设置页（第二 WebView）改动实时转发给桌宠页应用。 */
    override fun notifySettings(json: String) {
        web.evaluateJavascript(
            "window.__applySettingsFromAndroid?.(($json))",
            null
        )
    }

    override fun shellAction(action: String) {
        when (action) {
            "open-main" -> closeSettings()
            "open-settings" -> openSettings()
            "exit" -> {
                PetOverlayService.stop(this)
                finishAndRemoveTask()
            }
            "open-overlay-settings" -> ShellBridgeHostDefaults.openOverlaySettings(this)
        }
    }
}

/** Host 公共小工具。 */
object ShellBridgeHostDefaults {
    fun openUrl(ctx: android.content.Context, url: String) {
        val uri = Uri.parse(url)
        val scheme = uri.scheme ?: return
        if (scheme != "http" && scheme != "https") return
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            // 无可用浏览器
        }
    }

    /** 跳系统悬浮窗授权页（Service 上下文需 NEW_TASK）。 */
    fun openOverlaySettings(ctx: android.content.Context) {
        try {
            ctx.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${ctx.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Exception) {
        }
    }
}
