plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "top.liminalselves.aliyapet"
    compileSdk = 36

    defaultConfig {
        applicationId = "top.liminalselves.aliyapet"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
}

// 共享前端产物打包进 assets：ui/dist → app/src/main/assets/pet
// （WebViewAssetLoader 以 https://appassets.androidplatform.net/ 虚拟域名提供，
//  fetch/XHR 与浏览器同源语义一致，file:// 不行的原因见 PetWebViewFactory）
// Sync 会清掉目标目录的旧哈希文件，避免历史构建产物堆积
val copyWebAssets by tasks.registering(Sync::class) {
    from(layout.projectDirectory.dir("../../ui/dist"))
    into(layout.projectDirectory.dir("src/main/assets/pet"))
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(copyWebAssets)
}
