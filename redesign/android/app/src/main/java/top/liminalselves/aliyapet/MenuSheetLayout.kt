package top.liminalselves.aliyapet

import android.content.Context
import android.provider.Settings
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.LinearLayout
import kotlin.math.abs
import kotlin.math.max

/**
 * 底部菜单容器：拦截「向下拖」手势整体下移，松手按位移/速度决定
 * 滑出关闭或回弹（BottomSheet 的标准下拉关闭交互）。
 * 竖向位移未超过 touchSlop 前不拦截，行点击/涟漪不受影响。
 */
class MenuSheetLayout @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : LinearLayout(context, attrs) {

    /** 滑出动画结束后的回调（Activity 里 dismiss Dialog）。 */
    var onDismissed: (() -> Unit)? = null

    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downRawY = 0f
    private var dragging = false
    private var tracker: VelocityTracker? = null
    private var dismissing = false

    private val animationsEnabled: Boolean
        get() = Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f
        ) > 0f

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downRawY = ev.rawY
                dragging = false
                tracker?.recycle()
                tracker = VelocityTracker.obtain()
                tracker?.addMovement(ev)
            }
            MotionEvent.ACTION_MOVE -> {
                tracker?.addMovement(ev)
                if (!dragging && ev.rawY - downRawY > slop) {
                    dragging = true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.recycle()
                tracker = null
            }
        }
        return dragging || super.onInterceptTouchEvent(ev)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        tracker?.addMovement(ev)
        when (ev.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                if (dragging) {
                    // 只跟向下位移，向上拖不回抽（内容不可滚动）
                    translationY = max(0f, ev.rawY - downRawY)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) {
                    dragging = false
                    tracker?.computeCurrentVelocity(1000)
                    val vy = tracker?.yVelocity ?: 0f
                    val shouldDismiss = ev.actionMasked == MotionEvent.ACTION_UP &&
                        (translationY > height * 0.3f || vy > 1200f)
                    if (shouldDismiss && !dismissing) {
                        dismissing = true
                        if (!animationsEnabled) {
                            translationY = height.toFloat()
                            onDismissed?.invoke()
                        } else {
                            animate().translationY(height.toFloat()).setDuration(180)
                                .setInterpolator(AccelerateInterpolator(1.2f))
                                .withEndAction { onDismissed?.invoke() }.start()
                        }
                    } else {
                        if (!animationsEnabled) translationY = 0f
                        else animate().translationY(0f).setDuration(180)
                            .setInterpolator(DecelerateInterpolator(1.6f)).start()
                    }
                }
                tracker?.recycle()
                tracker = null
            }
        }
        return dragging || abs(translationY) > 0.5f || super.onTouchEvent(ev)
    }
}
