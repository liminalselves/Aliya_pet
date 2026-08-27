package top.liminalselves.aliyapet.aliya_pet

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channel = "top.liminalselves.aliyapet/overlay"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "startOverlay" -> {
                        if (canDrawOverlays()) {
                            startOverlayService()
                            result.success(true)
                        } else {
                            result.success(false) // 需先请求权限
                        }
                    }
                    "stopOverlay" -> {
                        stopOverlayService()
                        result.success(true)
                    }
                    "isOverlayRunning" -> {
                        result.success(PetOverlayService.isRunning)
                    }
                    "requestOverlayPermission" -> {
                        requestOverlayPermission()
                        result.success(true)
                    }
                    "hasOverlayPermission" -> {
                        result.success(canDrawOverlays())
                    }
                    "openUrl" -> {
                        // 在系统浏览器打开链接（关于页/项目仓库），无需额外插件。
                        val url = call.argument<String>("url")
                        if (url.isNullOrEmpty()) {
                            result.success(false)
                        } else {
                            val opened = runCatching {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            }.isSuccess
                            result.success(opened)
                        }
                    }
                    "notifyOverlaySettings" -> {
                        // 主 App 设置变更 → 转发给运行中的悬浮窗引擎。
                        PetOverlayService.notifySettingsChanged()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun canDrawOverlays(): Boolean =
        Settings.canDrawOverlays(this)

    private fun requestOverlayPermission() {
        if (canDrawOverlays()) return
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:$packageName")
        )
        startActivity(intent)
    }

    private fun startOverlayService() {
        val intent = Intent(this, PetOverlayService::class.java).apply {
            action = PetOverlayService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopOverlayService() {
        val intent = Intent(this, PetOverlayService::class.java).apply {
            action = PetOverlayService.ACTION_STOP
        }
        startService(intent)
    }
}
