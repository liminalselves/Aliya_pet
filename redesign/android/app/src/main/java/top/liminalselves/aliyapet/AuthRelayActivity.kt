package top.liminalselves.aliyapet

import android.content.Intent
import android.os.Bundle

/**
 * MiAuth 回跳中转（aliyapet://miauth/?session=...）：把查询串写入壳侧偏好后立即退场。
 *
 * 不直接落在 MainActivity 上——回前台会触发 onStart → 停掉悬浮窗服务，
 * 悬浮窗里等待授权的聊天页会整个被销毁。中转页只写 SharedPreferences：
 * 悬浮窗运行中 → 保持现状（前端 500ms 轮询自取，授权原地完成）；
 * 未运行（App 内授权）→ 照旧拉起 MainActivity 回到应用。
 */
class AuthRelayActivity : android.app.Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        if (data?.scheme == "aliyapet" && data.host == "miauth") {
            data.encodedQuery?.let { ShellPrefs.setPref(this, "miauth_callback", it) }
        }
        if (!PetOverlayService.isRunning) {
            try {
                startActivity(
                    Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
            }
        }
        finish()
    }
}
