package top.liminalselves.aliyapet

/** Display settings affect only the character overlay, never Activity or dialogue windows. */
internal data class PetDisplaySettings(val opacity: Float = 100f, val fullClickThrough: Boolean = false) {
    val ignoresTouch: Boolean get() = fullClickThrough || opacity == 0f

    companion object {
        fun normalized(opacity: Float, fullClickThrough: Boolean) = PetDisplaySettings(
            if (opacity.isFinite()) opacity.coerceIn(0f, 100f) else 100f,
            fullClickThrough
        )
    }
}

internal object PetDisplayPolicy {
    fun notTouchable(settings: PetDisplaySettings, temporaryPassThrough: Boolean): Boolean =
        settings.ignoresTouch || temporaryPassThrough

    /**
     * CSS controls character opacity without changing the WebGL alpha mask. Android 12+
     * additionally requires WINDOW alpha <= the system's obscuring limit for untrusted
     * NOT_TOUCHABLE overlays. CSS alpha alone does not meet that security requirement.
     * An unavailable/invalid limit fails closed visually (alpha=0), not with a touch wall.
     */
    fun windowAlpha(settings: PetDisplaySettings, temporaryPassThrough: Boolean,
                    sdkInt: Int, maximumObscuringOpacity: Float?): Float {
        if (settings.opacity == 0f) return 0f
        if (sdkInt < 31 || !notTouchable(settings, temporaryPassThrough)) return 1f
        return maximumObscuringOpacity?.takeIf { it.isFinite() && it in 0f..1f } ?: 0f
    }
}
