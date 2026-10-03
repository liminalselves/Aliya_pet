package top.liminalselves.aliyapet

import android.content.Intent
import android.os.Bundle

/** MiAuth is owned by the main pet page, including callbacks after process recreation. */
class AuthRelayActivity : android.app.Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        if (data?.scheme == "aliyapet" && data.host == "miauth") {
            data.encodedQuery?.let { ShellPrefs.setPref(this, "miauth_callback", it) }
            startActivity(Intent(this, MainActivity::class.java)
                .setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        }
        finish()
    }
}
