package top.liminalselves.aliyapet

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Rect
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.animation.PathInterpolator
import android.widget.LinearLayout
import android.widget.ScrollView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A small native sheet: drag at the handle, or pull down when its content is at the top.
 * Only translationY animates; the scroll container keeps long/large-text menus reachable.
 */
class MenuSheetLayout @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : LinearLayout(context, attrs) {

    var onDismissed: (() -> Unit)? = null

    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val drawerCurve = PathInterpolator(0.32f, 0.72f, 0f, 1f)
    private var downRawX = 0f
    private var downRawY = 0f
    private var startTranslationY = 0f
    private var activePointer = MotionEvent.INVALID_POINTER_ID
    private var downInScroll = false
    private var dragging = false
    private var tracker: VelocityTracker? = null
    private var dismissing = false
    private val contentScroll: ScrollView? get() = findViewById(R.id.menu_scroll)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Leave a visible outside-dismiss area, including on landscape and with large text.
        val screenLimit = (resources.displayMetrics.heightPixels * 0.88f).roundToInt()
        val suppliedLimit = MeasureSpec.getSize(heightMeasureSpec).takeIf { it > 0 } ?: screenLimit
        super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(min(screenLimit, suppliedLimit), MeasureSpec.AT_MOST))
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        if (dismissing) return true
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // Retarget from the current position rather than restart a return animation.
                animate().cancel()
                downRawX = ev.rawX
                downRawY = ev.rawY
                startTranslationY = translationY
                activePointer = ev.getPointerId(0)
                dragging = false
                val bounds = Rect()
                downInScroll = contentScroll?.let { it.getHitRect(bounds); bounds.contains(ev.x.toInt(), ev.y.toInt()) } == true
                tracker?.recycle()
                tracker = VelocityTracker.obtain().also { it.addMovement(ev) }
            }
            MotionEvent.ACTION_MOVE -> {
                tracker?.addMovement(ev)
                beginDragIfEligible(ev)
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (ev.getPointerId(ev.actionIndex) == activePointer) finishDrag(cancelled = true)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                finishDrag(cancelled = true)
            }
        }
        return dragging || super.onInterceptTouchEvent(ev)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        if (dismissing) return true
        tracker?.addMovement(ev)
        when (ev.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                // A down on the non-clickable handle/header targets this View directly,
                // so later moves need the same slop gate as intercepted content touches.
                beginDragIfEligible(ev)
                val index = ev.findPointerIndex(activePointer)
                if (dragging && index >= 0) {
                    translationY = max(0f, startTranslationY + rawY(ev, index) - downRawY - slop)
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (ev.getPointerId(ev.actionIndex) == activePointer) finishDrag(cancelled = true)
            }
            MotionEvent.ACTION_UP -> finishDrag(cancelled = false)
            MotionEvent.ACTION_CANCEL -> finishDrag(cancelled = true)
        }
        return true
    }

    private fun beginDragIfEligible(ev: MotionEvent) {
        val index = ev.findPointerIndex(activePointer)
        if (dragging || index < 0) return
        val dy = rawY(ev, index) - downRawY
        val dx = ev.getX(index) + ev.rawX - ev.x - downRawX
        if (dy > slop && dy > abs(dx) && (!downInScroll || contentScroll?.canScrollVertically(-1) != true)) {
            dragging = true
            parent?.requestDisallowInterceptTouchEvent(true)
        }
    }

    private fun rawY(ev: MotionEvent, index: Int): Float = ev.getY(index) + ev.rawY - ev.y

    private fun finishDrag(cancelled: Boolean) {
        tracker?.computeCurrentVelocity(1000)
        val vy = if (activePointer != MotionEvent.INVALID_POINTER_ID) tracker?.getYVelocity(activePointer) ?: 0f else 0f
        val shouldDismiss = dragging && !cancelled &&
            (translationY > height * 0.3f || (translationY > slop && vy > 1000f * resources.displayMetrics.density))
        dragging = false
        activePointer = MotionEvent.INVALID_POINTER_ID
        tracker?.recycle()
        tracker = null
        if (shouldDismiss) dismissing = true
        if (!ValueAnimator.areAnimatorsEnabled()) {
            if (shouldDismiss) onDismissed?.invoke() else translationY = 0f
        } else if (shouldDismiss || translationY > 0f) {
            animate()
                .translationY(if (shouldDismiss) height.toFloat() else 0f)
                .setDuration(if (shouldDismiss) 180L else 220L)
                .setInterpolator(drawerCurve)
                .withEndAction { if (shouldDismiss) onDismissed?.invoke() }
                .start()
        }
    }

    override fun onDetachedFromWindow() {
        animate().cancel()
        tracker?.recycle()
        tracker = null
        super.onDetachedFromWindow()
    }
}
