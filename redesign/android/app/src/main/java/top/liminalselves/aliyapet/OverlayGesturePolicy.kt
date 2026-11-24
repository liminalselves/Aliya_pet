package top.liminalselves.aliyapet

/**
 * 悬浮宠单指手势判定（纯函数，便于 JVM 测试）。
 *
 * 按下即可拖：手指移出 touchSlop 立刻由壳接管拖动，不需要先长按。
 * 前端声明了抚摸等互动（canArm=false）时，移出 slop 的手势作废（VOID），留给 WebView。
 * 轻点 = 未移出 slop 且短于长按时长，参与双击判定。
 */
internal object OverlayGesturePolicy {
    /** PENDING=按下待定，ARMED=壳接管拖动，VOID=手势归前端互动（不点击也不拖动）。 */
    enum class Phase { PENDING, ARMED, VOID }

    /** 按住期间的状态推进；dist2 为相对 DOWN 的位移平方（物理 px²）。 */
    fun advance(phase: Phase, dist2: Float, slop: Int, canArm: Boolean): Phase =
        if (phase != Phase.PENDING || dist2 <= slop.toFloat() * slop) phase
        else if (canArm) Phase.ARMED
        else Phase.VOID

    /** 触摸起点落在可抚摸头部区时，明显纵向拉动仍允许壳接管拖动，横向/斜向保留给前端抚摸。 */
    fun canArmFromZone(dx: Float, dy: Float, jsInteracting: Boolean): Boolean =
        !jsInteracting || kotlin.math.abs(dy) > kotlin.math.abs(dx) * 1.35f

    /** 抬手时是否算一次轻点（可参与双击）：未移出 slop、未按满长按时长。 */
    fun isTap(phase: Phase, elapsedMs: Long, dist2: Float, slop: Int, longPressMs: Long): Boolean =
        phase == Phase.PENDING && elapsedMs < longPressMs && dist2 <= slop.toFloat() * slop
}

/**
 * 悬浮窗拖动手势速度跟踪（EMA，时间常数 35ms，与前端 pet-app.ts 同口径）。
 * 支持从 PENDING → ARMED 首帧即开始累计速度，避免快速短甩（仅 0~1 次后续 MOVE）丢速度。
 */
internal class OverlayDragVelocity {
    var vxCss = 0f
        private set
    var vyCss = 0f
        private set
    var maxSpeedCss = 0f
        private set
    var lastRawX = 0f
        private set
    var lastRawY = 0f
        private set
    var lastTimeMs = 0L
        private set

    fun reset(rawX: Float, rawY: Float, eventTimeMs: Long) {
        vxCss = 0f
        vyCss = 0f
        maxSpeedCss = 0f
        lastRawX = rawX
        lastRawY = rawY
        lastTimeMs = eventTimeMs
    }

    fun trackAnchor(rawX: Float, rawY: Float, eventTimeMs: Long) {
        lastRawX = rawX
        lastRawY = rawY
        lastTimeMs = eventTimeMs
    }

    fun addSample(rawX: Float, rawY: Float, eventTimeMs: Long, density: Float) {
        if (eventTimeMs <= lastTimeMs) {
            lastRawX = rawX
            lastRawY = rawY
            return
        }
        val elapsed = eventTimeMs - lastTimeMs
        val dtSec = elapsed / 1000f
        val d = density.coerceAtLeast(1f)
        val instVx = (rawX - lastRawX) / d / dtSec
        val instVy = (rawY - lastRawY) / d / dtSec
        val alpha = 1f - kotlin.math.exp(-dtSec / 0.035f)
        vxCss += (instVx - vxCss) * alpha
        vyCss += (instVy - vyCss) * alpha
        maxSpeedCss = maxOf(maxSpeedCss, kotlin.math.hypot(vxCss, vyCss))
        lastRawX = rawX
        lastRawY = rawY
        lastTimeMs = eventTimeMs
    }

    fun releaseVelocity(eventTimeMs: Long, cancelled: Boolean): Pair<Float, Float> {
        if (cancelled) return 0f to 0f
        val staleMs = (eventTimeMs - lastTimeMs).coerceAtLeast(0L)
        val decay = if (staleMs > 120L) 0f else kotlin.math.exp(-staleMs / 45f)
        return (vxCss * decay) to (vyCss * decay)
    }
}

/**
 * 悬浮窗弹球原生 VSYNC 外推器（纯函数，便于 JVM 测试）。
 *
 * 与前端 PinballPhysics 同参数：当 WebView rAF 低于显示器刷新率时，
 * Choreographer 在相邻 JS 快照之间做有界物理前推（最多 MAX_EXTRAPOLATE_SEC），
 * 使悬浮窗位置严格以屏幕原生刷新率更新；每次 JS 新快照到达立即以权威状态重锚。
 */
internal object PinballMotionStepper {
    const val GRAVITY = 1600f
    const val AIR_DRAG = 0.15f
    const val GROUND_DRAG = 2.2f
    const val GROUND_HIT_FRICTION = 0.96f
    const val RESTITUTION_X = 0.90f
    const val RESTITUTION_Y = 0.88f
    const val GROUND_BOUNCE_MIN_VY = 120f
    const val MAX_EXTRAPOLATE_SEC = 0.032f
    private const val SUBSTEP_SEC = 1f / 240f

    data class State(
        val x: Float,
        val y: Float,
        val vx: Float,
        val vy: Float,
    )

    fun extrapolate(
        x0: Float,
        y0: Float,
        vx0: Float,
        vy0: Float,
        minX: Float,
        maxX: Float,
        minY: Float,
        maxY: Float,
        elapsedSec: Float,
    ): State {
        val loX = minOf(minX, maxX)
        val hiX = maxOf(minX, maxX)
        val loY = minOf(minY, maxY)
        val hiY = maxOf(minY, maxY)
        var x = x0.coerceIn(loX, hiX)
        var y = y0.coerceIn(loY, hiY)
        var vx = vx0
        var vy = vy0
        var rem = elapsedSec.coerceIn(0f, MAX_EXTRAPOLATE_SEC)
        if (rem <= 0f) return State(x, y, vx, vy)

        while (rem > 1e-6f) {
            val dt = minOf(rem, SUBSTEP_SEC)
            rem -= dt
            val grounded = y >= hiY - 0.5f && kotlin.math.abs(vy) < 1f
            if (grounded) {
                y = hiY
                vy = 0f
                vx *= kotlin.math.exp(-GROUND_DRAG * dt)
                x += vx * dt
            } else {
                vy += GRAVITY * dt
                val air = kotlin.math.exp(-AIR_DRAG * dt)
                vx *= air
                vy *= air
                x += vx * dt
                y += vy * dt
            }
            if (x < loX) {
                x = loX
                if (vx < 0f) vx = -vx * RESTITUTION_X
            } else if (x > hiX) {
                x = hiX
                if (vx > 0f) vx = -vx * RESTITUTION_X
            }
            if (y < loY) {
                y = loY
                if (vy < 0f) vy = -vy * RESTITUTION_Y
            } else if (y > hiY) {
                y = hiY
                if (vy > 0f) {
                    if (vy < GROUND_BOUNCE_MIN_VY) {
                        vy = 0f
                    } else {
                        vy = -vy * RESTITUTION_Y
                        vx *= GROUND_HIT_FRICTION
                    }
                }
            }
        }
        return State(x, y, vx, vy)
    }
}

/**
 * 弹球快照与原生拖动的代际门控（纯状态机，便于 JVM 测试）：
 * 原生接管拖动后屏蔽来自拖动前手势/旧 rAF 帧的迟到 syncPinballFrame，
 * 直到 JS 队列执行到本轮 onNativeDragEnd 时才重新放行。
 */
internal class PinballSyncGate {
    private var epoch = 0L
    private var awaitingDragEnd = false

    fun onDragStart(): Long {
        epoch++
        awaitingDragEnd = true
        return epoch
    }

    fun onDragEndAck(ackEpoch: Long) {
        if (ackEpoch == epoch) awaitingDragEnd = false
    }

    fun reset() {
        epoch++
        awaitingDragEnd = false
    }

    fun allowsSnapshot(): Boolean = !awaitingDragEnd
}
