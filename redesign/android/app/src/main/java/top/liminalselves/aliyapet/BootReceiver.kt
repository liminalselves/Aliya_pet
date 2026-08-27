package top.liminalselves.aliyapet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * 开机/应用更新后自启悬浮窗（需用户已开启「开机自启」并授予悬浮窗权限）。
 * Android 12+/15 对后台启动前台服务有限制，BOOT_COMPLETED 在豁免清单内；
 * 个别 ROM 仍可能拦截，失败静默（下次打开 App 生效）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (ShellPrefs.getAutoStart(context) && Settings.canDrawOverlays(context)) {
                    try {
                        PetOverlayService.start(context)
                    } catch (_: Exception) {
                        // 受限环境：放弃自启
                    }
                }
            }
        }
    }
}
