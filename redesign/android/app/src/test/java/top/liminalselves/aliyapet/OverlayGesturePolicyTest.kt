package top.liminalselves.aliyapet

import top.liminalselves.aliyapet.OverlayGesturePolicy.Phase

/** Dependency-free local JVM regression checks. Run with :app:testOverlayGesturePolicy. */
object OverlayGesturePolicyTest {
    private const val SLOP = 24
    private const val LONG = 400L

    /** Replays MOVE samples (px offset) and returns the final phase. */
    private fun replay(vararg offsets: Float, canArm: Boolean = true): Phase {
        var phase = Phase.PENDING
        for (d in offsets) phase = OverlayGesturePolicy.advance(phase, d * d, SLOP, canArm)
        return phase
    }

    @JvmStatic
    fun main(args: Array<String>) {
        // Quick tap with finger roll inside slop: never a drag, still a tap.
        check(replay(6f, 12f) == Phase.PENDING)
        check(OverlayGesturePolicy.isTap(Phase.PENDING, 120, 12f * 12f, SLOP, LONG))

        // Moving past slop drags immediately; no long press needed.
        check(replay(10f, 30f) == Phase.ARMED)
        check(OverlayGesturePolicy.advance(Phase.ARMED, 0f, SLOP, true) == Phase.ARMED)
        // Holding still never arms a drag by itself.
        check(replay(0f, 3f, 4f) == Phase.PENDING)

        // Front-end interaction (petting) owns the gesture: moving does not drag.
        check(replay(3f, 60f, canArm = false) == Phase.VOID)
        check(OverlayGesturePolicy.advance(Phase.VOID, 1e6f, SLOP, true) == Phase.VOID)

        // A held press, a drag or a slide is not a tap (and not a double-tap half).
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, LONG, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.ARMED, 100, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, 100, (SLOP + 1f) * (SLOP + 1f), SLOP, LONG))
        println("OverlayGesturePolicyTest: OK")
    }
}
