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

        // Front-end interaction (petting) owns the gesture: horizontal/diagonal does not drag,
        // while clear vertical pull from crown still lets the user lift/drag the overlay.
        check(replay(3f, 60f, canArm = false) == Phase.VOID)
        check(OverlayGesturePolicy.advance(Phase.VOID, 1e6f, SLOP, true) == Phase.VOID)
        check(!OverlayGesturePolicy.canArmFromZone(40f, 10f, jsInteracting = true))
        check(!OverlayGesturePolicy.canArmFromZone(30f, 30f, jsInteracting = true))
        check(OverlayGesturePolicy.canArmFromZone(10f, 40f, jsInteracting = true))
        check(OverlayGesturePolicy.canArmFromZone(40f, 10f, jsInteracting = false))

        // A held press, a drag or a slide is not a tap (and not a double-tap half).
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, LONG, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.ARMED, 100, 0f, SLOP, LONG))
        check(!OverlayGesturePolicy.isTap(Phase.PENDING, 100, (SLOP + 1f) * (SLOP + 1f), SLOP, LONG))

        // Fast flick crossing slop on a single ARMED move and releasing retains flick speed.
        val vel = OverlayDragVelocity()
        vel.reset(100f, 200f, 0L)
        vel.trackAnchor(112f, 200f, 8L)
        vel.addSample(148f, 188f, 16L, 2f)
        vel.addSample(172f, 180f, 24L, 2f)
        val (rvx, rvy) = vel.releaseVelocity(24L, cancelled = false)
        check(rvx > 400f && rvy < -100f && vel.maxSpeedCss >= rvx)

        // Same-timestamp sample must not divide by 1ms and spike speed.
        vel.addSample(176f, 180f, 24L, 2f)
        val (sameTvx, _) = vel.releaseVelocity(24L, cancelled = false)
        check(sameTvx == rvx)

        // Stale pause (>120ms) or cancellation zeroes release velocity.
        val (staleVx, staleVy) = vel.releaseVelocity(160L, cancelled = false)
        check(staleVx == 0f && staleVy == 0f)
        val (cancelVx, cancelVy) = vel.releaseVelocity(24L, cancelled = true)
        check(cancelVx == 0f && cancelVy == 0f)

        // Pinball VSYNC extrapolator: clamps negative elapsed, reflects off walls, never falls through floor.
        val clampZero = PinballMotionStepper.extrapolate(120f, 300f, 500f, -200f, 0f, 400f, 0f, 700f, -0.005f)
        check(clampZero.x == 120f && clampZero.y == 300f && clampZero.vx == 500f && clampZero.vy == -200f)

        val rightBounce = PinballMotionStepper.extrapolate(396f, 200f, 800f, 0f, 0f, 400f, 0f, 700f, 0.016f)
        check(rightBounce.x <= 400f && rightBounce.vx < 0f && rightBounce.vx >= -800f * PinballMotionStepper.RESTITUTION_X)

        val floorSlide = PinballMotionStepper.extrapolate(100f, 700f, 300f, 20f, 0f, 400f, 0f, 700f, 0.016f)
        check(floorSlide.y == 700f && floorSlide.vy == 0f && floorSlide.x > 100f && floorSlide.vx < 300f)

        // Upward post-bounce velocity (<120 px/s) must still lift off the floor instead of clamping grounded.
        val smallBounce = PinballMotionStepper.extrapolate(100f, 700f, 200f, -100f, 0f, 400f, 0f, 700f, 0.016f)
        check(smallBounce.y < 700f && smallBounce.vy < 0f)

        // PinballSyncGate: blocks stale snapshots until matching drag-end ack, ignores stale epoch acks.
        val gate = PinballSyncGate()
        check(gate.allowsSnapshot())
        val e1 = gate.onDragStart()
        check(!gate.allowsSnapshot())
        val e2 = gate.onDragStart()
        gate.onDragEndAck(e1)
        check(!gate.allowsSnapshot())
        gate.onDragEndAck(e2)
        check(gate.allowsSnapshot())

        val capped = PinballMotionStepper.extrapolate(100f, 200f, 1000f, 0f, 0f, 4000f, 0f, 700f, 5f)
        val atCap = PinballMotionStepper.extrapolate(100f, 200f, 1000f, 0f, 0f, 4000f, 0f, 700f, PinballMotionStepper.MAX_EXTRAPOLATE_SEC)
        check(capped == atCap)

        println("OverlayGesturePolicyTest: OK")
    }
}
