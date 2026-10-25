package top.liminalselves.aliyapet

import android.Manifest
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity(), ShellBridge.Host {
    companion object {
        @Volatile var exitRequested = false
        @Volatile var isForeground = false
            private set
    }

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private lateinit var menuBtn: android.widget.ImageButton
    private val pages = mutableListOf<WebView>()
    private var pendingOverlay = false
    private var menuDialog: Dialog? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var downloadBytes: ByteArray? = null
    private val saveFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val bytes = downloadBytes
        downloadBytes = null
        val uri = result.data?.data
        if (result.resultCode == RESULT_OK && uri != null && bytes != null) {
            Thread {
                val success = runCatching {
                    val output = contentResolver.openOutputStream(uri) ?: error("No output stream")
                    output.use { it.write(bytes) }
                }.isSuccess
                runOnUiThread {
                    Toast.makeText(this, if (success) R.string.toast_file_saved else R.string.toast_file_failed, Toast.LENGTH_LONG).show()
                }
            }.start()
        }
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }
    private val overlayPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (pendingOverlay && Settings.canDrawOverlays(this)) enterOverlay()
        else if (pendingOverlay) Toast.makeText(this, R.string.toast_need_overlay_permission, Toast.LENGTH_LONG).show()
        pendingOverlay = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        exitRequested = false
        val density = resources.displayMetrics.density
        root = FrameLayout(this)
        web = createWebView()
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        menuBtn = android.widget.ImageButton(this).apply {
            setImageResource(R.drawable.ic_menu_dots)
            scaleType = android.widget.ImageView.ScaleType.CENTER
            setPadding(0, 0, 0, 0)
            minimumWidth = 0
            minimumHeight = 0
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.fab_circle)
            contentDescription = getString(R.string.menu_title)
            setOnClickListener { showMenuSheet() }
        }
        val size = (44 * density).roundToInt()
        root.addView(menuBtn, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.END).apply {
            topMargin = (10 * density).roundToInt()
            marginEnd = (12 * density).roundToInt()
        })
        setContentView(root)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        androidx.core.view.WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        @Suppress("DEPRECATION")
        run {
            if (Build.VERSION.SDK_INT >= 29) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                    androidx.core.view.WindowInsetsControllerCompat(window, root).hide(WindowInsetsCompat.Type.ime())
                    return
                }
                val current = pages.lastOrNull() ?: web
                current.evaluateJavascript("""
                    (() => {
                        const dialog = document.querySelector('dialog[open]');
                        if (dialog) { if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close(); return true; }
                        return window.__pet?.handleBack?.() ?? false;
                    })()
                """.trimIndent()) { handled ->
                    if (isFinishing || isDestroyed) return@evaluateJavascript
                    if (handled != "true") {
                        if (pages.isNotEmpty()) closePage() else moveTaskToBack(true)
                    }
                }
            }
        })
        web.loadUrl(PetWebViewFactory.PET_URL)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    private fun createWebView(): WebView = PetWebViewFactory.create(this, ShellBridge(this), chooseFiles = { callback, params ->
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        try {
            filePicker.launch(params.createIntent())
        } catch (_: android.content.ActivityNotFoundException) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            Toast.makeText(this, R.string.toast_no_file_picker, Toast.LENGTH_LONG).show()
        }
    })

    override fun onStart() {
        super.onStart()
        isForeground = true
        exitRequested = false
        PetOverlayService.stop(this)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.__pet?.onShellEvent('resume')", null)
        (pages.lastOrNull() ?: web).let {
            it.onResume()
            it.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null)
        }
    }

    override fun onStop() {
        super.onStop()
        isForeground = false
        web.evaluateJavascript("window.__pet?.onShellEvent('pause')", null)
        web.onPause()
        pages.forEach { it.onPause() }
        if (!exitRequested && !isChangingConfigurations && ShellPrefs.getOverlayOnExit(this) && Settings.canDrawOverlays(this)) {
            PetOverlayService.start(this)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.data?.scheme == "aliyapet" || intent.getBooleanExtra("openMain", false)) closeAllPages()
    }

    override fun onDestroy() {
        menuDialog?.dismiss()
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        pages.forEach { root.removeView(it); it.destroy() }
        pages.clear()
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    /**
     * 子页面（设置/记录）从右侧滑入、返回时滑出（系统导航的标准方向）。
     * 新页先完全不透明盖住下层再开始位移，避免透明 WebView 首帧露出桌宠闪一下；
     * 下层页面在滑入结束后才隐藏，滑出开始前先恢复可见。
     */
    private fun openPage(url: String) {
        val current = pages.lastOrNull()
        if (current?.tag == url) return
        val page = createWebView()
        page.tag = url
        page.setBackgroundColor(ContextCompat.getColor(this, R.color.pet_background))
        pages.add(page)
        root.addView(page, FrameLayout.LayoutParams(-1, -1))
        page.loadUrl(url)
        hideMenuButton()
        val width = root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        page.translationX = width * 0.28f
        page.alpha = 0f
        page.animate()
            .translationX(0f).alpha(1f)
            .setDuration(PAGE_IN_MS)
            .setInterpolator(DecelerateInterpolator(2f))
            .withEndAction {
                if (pages.lastOrNull() !== page) return@withEndAction
                current?.visibility = View.INVISIBLE
                current?.onPause()
            }
            .start()
    }

    private fun closePage(animate: Boolean = true) {
        val page = pages.removeLastOrNull() ?: return
        val current = pages.lastOrNull() ?: web
        current.visibility = View.VISIBLE
        current.onResume()
        current.requestFocus()
        current.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null)
        if (pages.isEmpty()) showMenuButton()
        val finish = { root.removeView(page); page.destroy() }
        if (!animate) { page.animate().cancel(); finish(); return }
        page.animate().cancel()
        page.animate()
            .translationX(page.width * 0.22f).alpha(0f)
            .setDuration(PAGE_OUT_MS)
            .setInterpolator(AccelerateInterpolator(1.5f))
            .withEndAction(finish)
            .start()
    }

    private fun closeAllPages() {
        // 多层一起关：只给最上层播滑出，其余直接移除，避免层层叠播。
        while (pages.size > 1) closePage(animate = false)
        closePage()
    }

    private fun hideMenuButton() {
        menuBtn.animate().cancel()
        menuBtn.animate().alpha(0f).setDuration(PAGE_OUT_MS).withEndAction { menuBtn.visibility = View.GONE }.start()
    }

    private fun showMenuButton() {
        menuBtn.animate().cancel()
        menuBtn.visibility = View.VISIBLE
        menuBtn.animate().alpha(1f).setDuration(PAGE_IN_MS).start()
    }

    private fun showMenuSheet() {
        if (menuDialog?.isShowing == true) return
        val dialog = Dialog(this, R.style.MenuSheetDialog)
        menuDialog = dialog
        val view = layoutInflater.inflate(R.layout.menu_sheet, null) as MenuSheetLayout
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, (12 * resources.displayMetrics.density).roundToInt() + bars.bottom)
            insets
        }
        dialog.setContentView(view)
        view.onDismissed = { dialog.dismiss() }
        dialog.show()
        dialog.window?.apply {
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(this, false)
            setGravity(Gravity.BOTTOM)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            attributes = attributes.apply { dimAmount = 0.35f }
            @Suppress("DEPRECATION")
            run { navigationBarColor = ContextCompat.getColor(this@MainActivity, R.color.pet_surface) }
            androidx.core.view.WindowInsetsControllerCompat(this, view).isAppearanceLightNavigationBars = false
        }
        val actions = mapOf(
            R.id.menu_settings to "open-settings",
            R.id.menu_chat to "open-chat",
            R.id.menu_records to "open-records",
            R.id.menu_overlay to "enter-overlay",
            R.id.menu_about to "open-about",
            R.id.menu_quit to "exit"
        )
        actions.forEach { (id, action) ->
            view.findViewById<View>(id).setOnClickListener { dialog.dismiss(); shellAction(action) }
        }
    }

    private fun enterOverlay() {
        if (Settings.canDrawOverlays(this)) {
            ShellPrefs.setOverlayOnExit(this, true)
            moveTaskToBack(true)
        } else {
            pendingOverlay = true
            Toast.makeText(this, R.string.toast_need_overlay_permission, Toast.LENGTH_LONG).show()
            try {
                overlayPermission.launch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            } catch (_: android.content.ActivityNotFoundException) {
                pendingOverlay = false
                Toast.makeText(this, R.string.toast_need_overlay_permission, Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun metricsJson(): String {
        val dm = resources.displayMetrics
        val d = dm.density
        val w = dm.widthPixels / d
        val h = dm.heightPixels / d
        return "{\"density\":$d,\"screenW\":$w,\"screenH\":$h,\"winX\":0,\"winY\":0,\"winW\":$w,\"winH\":$h}"
    }

    override fun openUrl(url: String) = ShellBridgeHostDefaults.openUrl(this, url)
    override fun isOverlayGranted(): Boolean = Settings.canDrawOverlays(this)
    override fun setAutoStart(on: Boolean) = ShellPrefs.setAutoStart(this, on)
    override fun isAutoStart(): Boolean = ShellPrefs.getAutoStart(this)
    override fun setPref(key: String, value: String) = ShellPrefs.setPref(this, key, value)
    override fun getPref(key: String): String = ShellPrefs.getPref(this, key)
    override fun notifySettings(json: String) {
        web.evaluateJavascript("window.__applySettingsFromAndroid?.(($json))", null)
    }
    override fun notifyPetAction(json: String) {
        web.evaluateJavascript("window.__pet?.onShellAction($json)", null)
    }

    override fun saveDownload(name: String, mime: String, base64: String) {
        if (downloadBytes != null) return
        try {
            downloadBytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            saveFile.launch(Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime.substringBefore(';').ifBlank { "application/octet-stream" })
                .putExtra(Intent.EXTRA_TITLE, name.substringAfterLast('/').ifBlank { "aliya-export.json" }))
        } catch (_: Exception) {
            downloadBytes = null
            Toast.makeText(this, R.string.toast_file_failed, Toast.LENGTH_LONG).show()
        }
    }

    override fun shellAction(action: String) {
        when (action) {
            "back" -> closePage()
            "open-main" -> closeAllPages()
            "open-chat" -> {
                closeAllPages()
                web.evaluateJavascript("window.__pet?.onShellAction({action:'open-chat'})", null)
            }
            "open-records" -> openPage(PetWebViewFactory.RECORDS_URL)
            "open-settings" -> openPage(PetWebViewFactory.SETTINGS_URL)
            "open-session-control" -> openPage("${PetWebViewFactory.SETTINGS_URL}#session-control")
            "open-about" -> openPage("${PetWebViewFactory.SETTINGS_URL}#about")
            "enter-overlay" -> enterOverlay()
            "exit" -> {
                exitRequested = true
                PetOverlayService.stop(this)
                finishAndRemoveTask()
            }
            "open-overlay-settings" -> ShellBridgeHostDefaults.openOverlaySettings(this)
        }
    }
}

private const val PAGE_IN_MS = 240L
private const val PAGE_OUT_MS = 180L

object ShellBridgeHostDefaults {
    fun openUrl(ctx: android.content.Context, url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme !in listOf("http", "https")) return
        try {
            val intent = Intent(Intent.ACTION_VIEW, uri)
            if (ctx !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
        } catch (_: android.content.ActivityNotFoundException) {
            Toast.makeText(ctx, R.string.toast_no_browser, Toast.LENGTH_LONG).show()
        }
    }

    fun openOverlaySettings(ctx: android.content.Context) {
        try {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: android.content.ActivityNotFoundException) {
            Toast.makeText(ctx, R.string.toast_need_overlay_permission, Toast.LENGTH_LONG).show()
        }
    }
}
