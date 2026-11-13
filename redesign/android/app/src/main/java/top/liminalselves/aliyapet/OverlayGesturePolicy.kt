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

    /** 抬手时是否算一次轻点（可参与双击）：未移出 slop、未按满长按时长。 */
    fun isTap(phase: Phase, elapsedMs: Long, dist2: Float, slop: Int, longPressMs: Long): Boolean =
        phase == Phase.PENDING && elapsedMs < longPressMs && dist2 <= slop.toFloat() * slop
}
