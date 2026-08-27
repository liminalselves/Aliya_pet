pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        // 阿里云镜像（dl.google.com / repo.maven.apache.org 在部分网络不可达）
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    // AGP 8.13.1（AGP 9 内置 :jni 模块硬编码 NDK 28.x，本地无法满足；8.x 无此问题）
    id("com.android.application") version "8.13.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}

// AGP 内置 :jni 模块（native 构建）默认要求 NDK 28.x：强制使用本地已安装版本
gradle.beforeProject {
    if (name == "jni") {
        println("BEFORE_PROJECT jni detected, buildFile=${project.buildFile}, projectDir=${project.projectDir}")
        listOf("com.android.library", "com.android.application", "com.android.jni", "com.android.experimental.jni").forEach { id ->
            plugins.withId(id) {
                val ext = extensions.findByName("android")
                if (ext != null) {
                    ext.javaClass.getMethod("setNdkVersion", String::class.java)
                        .invoke(ext, "27.0.12077973")
                }
            }
        }
    }
}

include(":app")
