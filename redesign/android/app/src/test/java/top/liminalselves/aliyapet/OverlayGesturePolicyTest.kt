package top.liminalselves.aliyapet

import top.liminalselves.aliyapet.OverlayGesturePolicy.Phase

/** Dependency-free local JVM regression checks. Run with :app:testOverlayGesturePolicy. */
object OverlayGesturePolicyTest {
    private const val SLOP = 24
    private const val LONG = 400L

    /** Replays MOVE samples (ms, px offset) and returns the final phase. */
    private fun replay(vararg samples: Pair<Long, Float>, canArm: Boolean = true): Phase {
        var phase = Phase.PENDING
        for ((t, d) in samples) phase = OverlayGesturePolicy.advance(phase, t, d * d, SLOP, LONG, canArm)
        return phase
    }

    @JvmStatic
    fun main(args: Array<String>) {
        // Quick tap with finger roll: never a drag, still a tap.
        check(replay(30L to 6f, 80L to 12f) == Phase.PENDING)
        check(OverlayGesturePolicy.isTap(Phase.PENDING, 120, 12f * 12f, SLOP, LONG))

        // Fast flick before the long-press timeout: void, neither tap nor drag.
        val flick = replay(20L to 10f, 40L to 60f, 60L to 140f)
        check(flick == Phase.VOID)
        check(!OverlayGesturePolicy.isTap(flick, 80, 140f * 140f, SLOP, LONG))
        // Once void, holding still afterwards never arms a drag.
        check(OverlayGesturePolicy.advance(flick, 900, 0f, SLOP, LONG, true) == Phase.VOID)

        // Long press then move: drag. A MOVE arriving after the timeout arms even if it is far.
        check(replay(200L to 3f, 410L to 4f) == Phase.ARMED)
        check(replay(200L to 3f, 450L to 80f) == Phase.ARMED)
        check(OverlayGesturePolicy.advance(Phase.ARMED, 900, 1e6f, SLOP, LONG, true) == Phase.ARMED)

        // Front-end interaction (petting) owns the gesture: long press does not arm.
        check(replay(200L to 3f, 500L to 4f, canArm = false) == Phase.PENDING)
        check(replay(200L to 3f, 500L to 60f, canArm = false) == Phase.VOID)

        // A held press without movement is not a tap (and not a double-tap half).
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, LONG, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.ARMED, 100, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, 100, (SLOP + 1f) * (SLOP + 1f), SLOP, LONG))
        println("OverlayGesturePolicyTest: OK")
    }
}
