package top.liminalselves.aliyapet

import android.content.Context
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

    /** 拖动下移时回调当前位移比例（0=完全展开，1=完全收起），遮罩随之变淡。 */
    var onDragProgress: ((Float) -> Unit)? = null

    /** 复用同一个视图：每次打开前清掉上次下拉关闭留下的状态。 */
    fun resetState() {
        animate().cancel()
        dragging = false
        dismissing = false
    }

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
        when (ev.actionMasked) {
            // 按在把手/留白等无子 View 接管的区域时，事件直接落到这里：必须消费 DOWN，
            // 否则后续 MOVE 不再派发，顶部区域无法下拉关闭。
            MotionEvent.ACTION_DOWN -> {
                downRawY = ev.rawY
                dragging = false
                tracker?.recycle()
                tracker = VelocityTracker.obtain()
                tracker?.addMovement(ev)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                tracker?.addMovement(ev)
                if (!dragging && ev.rawY - downRawY > slop) dragging = true
                if (dragging) {
                    // 只跟向下位移，向上拖不回抽（内容不可滚动）
                    translationY = max(0f, ev.rawY - downRawY)
                    if (height > 0) onDragProgress?.invoke(translationY / height)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.addMovement(ev)
                if (dragging) {
                    dragging = false
                    tracker?.computeCurrentVelocity(1000)
                    val vy = tracker?.yVelocity ?: 0f
                    val shouldDismiss = ev.actionMasked == MotionEvent.ACTION_UP &&
                        (translationY > height * 0.3f || vy > 1200f)
                    if (shouldDismiss && !dismissing) {
                        dismissing = true
                        animate()
                            .translationY(height.toFloat())
                            .setDuration(180)
                            .setInterpolator(AccelerateInterpolator(1.2f))
                            .setUpdateListener { if (height > 0) onDragProgress?.invoke(translationY / height) }
                            .withEndAction { onDismissed?.invoke() }
                            .start()
                    } else {
                        animate()
                            .translationY(0f)
                            .setDuration(220)
                            .setInterpolator(DecelerateInterpolator(1.6f))
                            .setUpdateListener { if (height > 0) onDragProgress?.invoke(translationY / height) }
                            .start()
                    }
                }
                tracker?.recycle()
                tracker = null
            }
        }
        return dragging || abs(translationY) > 0.5f || super.onTouchEvent(ev)
    }
}
