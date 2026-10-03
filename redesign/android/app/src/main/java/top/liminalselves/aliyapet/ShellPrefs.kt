package top.liminalselves.aliyapet

import android.content.Context

/**
 * 壳侧偏好（SharedPreferences）：前端经 ShellBridge setPref/getPref 读写。
 * 键与前端约定一致：petX/petY（CSS px）、overlayOnExit、autoStart。
 */
object ShellPrefs {
    private const val FILE = "pet_shell"
    private const val K_AUTO_START = "autoStart"
    private const val K_OVERLAY_ON_EXIT = "overlayOnExit"
    private const val K_PET_X = "petX"
    private const val K_PET_Y = "petY"

    private fun sp(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun getAutoStart(ctx: Context): Boolean = sp(ctx).getBoolean(K_AUTO_START, false)

    fun setAutoStart(ctx: Context, on: Boolean) {
        sp(ctx).edit().putBoolean(K_AUTO_START, on).apply()
    }

    /** 退出 App 后是否显示悬浮窗（默认开）。 */
    fun getOverlayOnExit(ctx: Context): Boolean =
        sp(ctx).getString(K_OVERLAY_ON_EXIT, "1") == "1"

    fun setOverlayOnExit(ctx: Context, on: Boolean) {
        sp(ctx).edit().putString(K_OVERLAY_ON_EXIT, if (on) "1" else "0").apply()
    }

    /** 悬浮窗位置（CSS px；null=未保存）。 */
    fun getPetPos(ctx: Context): Pair<Float, Float>? {
        val sp = sp(ctx)
        if (!sp.contains(K_PET_X) || !sp.contains(K_PET_Y)) return null
        return Pair(sp.getFloat(K_PET_X, 0f), sp.getFloat(K_PET_Y, 0f))
    }

    fun setPetPos(ctx: Context, xCss: Float, yCss: Float) {
        sp(ctx).edit()
            .putFloat(K_PET_X, xCss)
            .putFloat(K_PET_Y, yCss)
            .apply()
    }

    /** 前端通用键值通道（目前 petX/petY 以字符串形式写入，兼容字符串读取）。 */
    fun getPref(ctx: Context, key: String): String {
        val sp = sp(ctx)
        return when (key) {
            "autoStart" -> if (sp.getBoolean(K_AUTO_START, false)) "1" else "0"
            "overlayOnExit" -> if (sp.getString(K_OVERLAY_ON_EXIT, "1") == "1") "1" else "0"
            "petX", "petY" -> if (sp.contains(key)) sp.getFloat(key, 0f).toString() else ""
            else -> sp.getString(key, "") ?: ""
        }
    }

    fun setPref(ctx: Context, key: String, value: String) {
        val editor = sp(ctx).edit()
        when (key) {
            "autoStart" -> editor.putBoolean(K_AUTO_START, value == "1" || value == "true")
            "petX" -> editor.putFloat(K_PET_X, value.toFloatOrNull() ?: 0f)
            "petY" -> editor.putFloat(K_PET_Y, value.toFloatOrNull() ?: 0f)
            else -> editor.putString(key, value)
        }
        editor.apply()
    }
}
