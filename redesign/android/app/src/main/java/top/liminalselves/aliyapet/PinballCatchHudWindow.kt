package top.liminalselves.aliyapet

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * 弹球模式抓取计分浮标（独立原生浮层，不占用台词气泡）。
 * 样式与 ui/src/pet.css `.pinball-catch-hud` 及 tokens.css 对齐。
 */
internal class PinballCatchHudWindow(
    private val context: Context,
    private val wm: WindowManager,
) {
    private val main = Handler(Looper.getMainLooper())
    private val density get() = context.resources.displayMetrics.density
    private val ease = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)

    private var container: LinearLayout? = null
    private var scoreView: TextView? = null
    private var metaView: TextView? = null
    private var attached = false
    private var destroyed = false
    private var revision = 0

    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        alpha = 1f
        title = "Aliya pinball score"
        if (Build.VERSION.SDK_INT >= 28) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    private fun ensureView(): LinearLayout {
        container?.let { return it }
        val d = density
        val bg = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 999f * d
            setColor(Color.argb(251, 36, 34, 32))
            setStroke((1f * d).roundToInt().coerceAtLeast(1), Color.argb(33, 255, 246, 236))
        }
        val score = TextView(context).apply {
            setTextColor(ContextCompat.getColor(context, R.color.pet_accent))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        }
        val meta = TextView(context).apply {
            setTextColor(Color.rgb(186, 179, 172))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            maxLines = 1
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = (2f * d).roundToInt()
            }
        }
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = bg
            elevation = 8f * d
            val px = (14f * d).roundToInt()
            val py = (6f * d).roundToInt()
            setPadding(px, py, px, py)
            addView(score)
            addView(meta)
        }
        container = box
        scoreView = score
        metaView = meta
        return box
    }

    fun show(json: String, petX: Int, petY: Int) {
        if (destroyed) return
        val payload = try {
            JSONObject(json)
        } catch (error: org.json.JSONException) {
            Log.e("PinballCatchHudWindow", "Invalid HUD payload", error)
            hide()
            return
        }
        val score = payload.optInt("score", 0)
        val speed = payload.optInt("speedPxPerSec", 0)
        val sizePercent = payload.optInt("sizePercent", 100)
        if (score <= 0) {
            hide()
            return
        }
        val view = ensureView()
        val currentRev = ++revision
        main.removeCallbacksAndMessages(null)
        view.animate().cancel()

        scoreView?.text = "抓到啦 +$score 分"
        metaView?.text = "速度 $speed px/s · 大小 $sizePercent%"

        val spec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        view.measure(spec, spec)
        val w = view.measuredWidth.coerceAtLeast(1)
        val h = view.measuredHeight.coerceAtLeast(1)
        params.width = w
        params.height = h

        val (screenW, screenH, safeTop) = screenBounds()
        val d = density
        val margin = (8f * d).roundToInt()
        val gap = (10f * d).roundToInt()
        val centerX = payload.optDouble("centerX", 0.0).takeIf { it.isFinite() } ?: 0.0
        val headY = payload.optDouble("headY", 0.0).takeIf { it.isFinite() } ?: 0.0
        val anchorX = petX + centerX * d
        val anchorY = petY + headY * d

        params.x = (anchorX - w / 2.0).roundToInt()
            .coerceIn(margin, (screenW - w - margin).coerceAtLeast(margin))
        params.y = (anchorY - h - gap).roundToInt()
            .coerceIn(safeTop + margin, (screenH - h - margin).coerceAtLeast(safeTop + margin))

        if (attached) {
            runCatching { wm.updateViewLayout(view, params) }
        } else {
            try {
                wm.addView(view, params)
                attached = true
            } catch (error: RuntimeException) {
                Log.e("PinballCatchHudWindow", "Cannot add pinball catch HUD", error)
                if (view.parent != null) runCatching { wm.removeViewImmediate(view) }
                attached = false
                return
            }
        }

        val reduced = isReducedMotion()
        view.alpha = 0f
        view.translationY = if (reduced) 0f else 6f * d
        view.scaleX = if (reduced) 1f else 0.9f
        view.scaleY = if (reduced) 1f else 0.9f
        view.animate()
            .alpha(1f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(if (reduced) 140L else 220L)
            .setInterpolator(ease)
            .setListener(null)
            .start()

        main.postDelayed({
            if (!destroyed && revision == currentRev) fadeOut(currentRev)
        }, 2200L)
    }

    private fun fadeOut(expectedRev: Int) {
        val view = container
        if (destroyed || !attached || view == null) return
        val reduced = isReducedMotion()
        val d = density
        view.animate().cancel()
        view.animate()
            .alpha(0f)
            .translationY(if (reduced) 0f else -4f * d)
            .scaleX(if (reduced) 1f else 0.96f)
            .scaleY(if (reduced) 1f else 0.96f)
            .setDuration(if (reduced) 140L else 220L)
            .setInterpolator(ease)
            .setListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (!destroyed && revision == expectedRev) detach()
                }
            })
            .start()
    }

    fun hide() {
        revision++
        main.removeCallbacksAndMessages(null)
        container?.animate()?.cancel()
        detach()
    }

    fun destroy() {
        if (destroyed) return
        hide()
        destroyed = true
        container = null
        scoreView = null
        metaView = null
    }

    private fun detach() {
        val view = container ?: return
        if (attached) {
            runCatching { wm.removeViewImmediate(view) }
            attached = false
        }
    }

    private fun isReducedMotion(): Boolean =
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)

    private fun screenBounds(): Triple<Int, Int, Int> {
        return if (Build.VERSION.SDK_INT >= 30) {
            val metrics = wm.currentWindowMetrics
            val safeTop = metrics.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout(),
            ).top
            Triple(metrics.bounds.width(), metrics.bounds.height(), safeTop)
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            val id = context.resources.getIdentifier("status_bar_height", "dimen", "android")
            val safeTop = if (id != 0) context.resources.getDimensionPixelSize(id) else 0
            Triple(metrics.widthPixels, metrics.heightPixels, safeTop)
        }
    }
}
