package top.liminalselves.aliyapet

/** Dependency-free local JVM regression checks. Run with :app:testPetDisplayPolicy. */
object PetDisplayPolicyTest {
    @JvmStatic
    fun main(args: Array<String>) {
        val smart = PetDisplaySettings.normalized(100f, false)
        check(!PetDisplayPolicy.notTouchable(smart, false))
        check(PetDisplayPolicy.windowAlpha(smart, false, 36, 0.8f) == 1f)

        // 0% must never intercept, including smart mode before any JS alpha mask arrives.
        for (sdk in listOf(26, 30, 31, 32, 33, 36)) {
            for (full in listOf(false, true)) {
                val invisible = PetDisplaySettings.normalized(0f, full)
                check(PetDisplayPolicy.notTouchable(invisible, false))
                check(PetDisplayPolicy.windowAlpha(invisible, false, sdk, null) == 0f)
            }
        }

        val passive = PetDisplaySettings.normalized(100f, true)
        check(PetDisplayPolicy.notTouchable(passive, false))
        // CSS opacity cannot satisfy Android 12's window-level security policy.
        check(PetDisplayPolicy.windowAlpha(passive, false, 30, null) == 1f)
        check(PetDisplayPolicy.windowAlpha(passive, false, 31, 0.8f) == 0.8f)
        check(PetDisplayPolicy.windowAlpha(passive, false, 36, 0.65f) == 0.65f)
        check(PetDisplayPolicy.windowAlpha(PetDisplaySettings.normalized(50f, true), false, 36, 0.8f) == 0.8f)

        // A legacy transparent-DOWN timer expiring cannot cancel persistent full pass-through.
        for (temporary in listOf(true, false)) {
            check(PetDisplayPolicy.notTouchable(passive, temporary))
            check(PetDisplayPolicy.windowAlpha(passive, temporary, 32, 0.8f) == 0.8f)
        }
        check(PetDisplayPolicy.notTouchable(smart, true))
        check(PetDisplayPolicy.windowAlpha(smart, true, 32, 0.8f) == 0.8f)
        check(!PetDisplayPolicy.notTouchable(smart, false))
        check(PetDisplayPolicy.windowAlpha(smart, false, 32, 0.8f) == 1f)

        // Missing, malformed, or vendor-invalid limits hide the passive overlay safely.
        for (limit in listOf(null, Float.NaN, Float.POSITIVE_INFINITY, -0.1f, 1.1f)) {
            check(PetDisplayPolicy.windowAlpha(passive, false, 31, limit) == 0f)
        }
        check(PetDisplayPolicy.windowAlpha(passive, false, 31, 0f) == 0f)
        check(PetDisplayPolicy.windowAlpha(passive, false, 31, 1f) == 1f)

        check(PetDisplaySettings.normalized(-1f, false).opacity == 0f)
        check(PetDisplaySettings.normalized(101f, true).opacity == 100f)
        check(PetDisplaySettings.normalized(Float.NaN, false).opacity == 100f)
        check(PetDisplaySettings.normalized(Float.NEGATIVE_INFINITY, false).opacity == 100f)
        check(PetDisplaySettings.normalized(42.5f, false).opacity == 42.5f)
        println("PetDisplayPolicyTest: all local JVM regression checks passed")
    }
}
