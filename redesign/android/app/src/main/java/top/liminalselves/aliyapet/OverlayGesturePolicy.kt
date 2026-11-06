package top.liminalselves.aliyapet

/**
 * 悬浮宠单指手势判定（纯函数，便于 JVM 测试）。
 *
 * 拖动必须长按：按住不动达到 [longPressMs] 才进入拖动，之后才跟手移动窗口。
 * 未到长按时间就移动超过 slop 的手势不是拖动，而是作废的轻扫（不算点击，也不搬窗口）；
 * 这样快速点按时手指的轻微滑动或抬手落点偏移，不会再被误判成拖动。
 */
internal object OverlayGesturePolicy {
    /** PENDING=按下待定，ARMED=长按成立、壳接管拖动，VOID=长按前已滑开（不点击也不拖动）。 */
    enum class Phase { PENDING, ARMED, VOID }

    /**
     * 按住期间的状态推进；elapsedMs 自 DOWN 起，dist2 为相对 DOWN 的位移平方（物理 px²）。
     * 先判长按：MOVE 是连续采样，长按前的滑开会在更早的 MOVE 里先被判 VOID。
     * canArm=false（前端声明了抚摸等互动）时长按不接管，手势留给 WebView。
     */
    fun advance(phase: Phase, elapsedMs: Long, dist2: Float, slop: Int, longPressMs: Long, canArm: Boolean): Phase =
        if (phase != Phase.PENDING) phase
        else if (elapsedMs >= longPressMs && canArm) Phase.ARMED
        else if (dist2 > slop.toFloat() * slop) Phase.VOID
        else Phase.PENDING

    /** 抬手时是否算一次轻点（可参与双击）：未长按、未移出 slop。 */
    fun isTap(phase: Phase, elapsedMs: Long, dist2: Float, slop: Int, longPressMs: Long): Boolean =
        phase == Phase.PENDING && elapsedMs < longPressMs && dist2 <= slop.toFloat() * slop
}
