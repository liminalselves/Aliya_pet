import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 正式签名（keystore.properties 不入库；缺失时 release 产物为未签名）
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "top.liminalselves.aliyapet"
    compileSdk = 36

    defaultConfig {
        applicationId = "top.liminalselves.aliyapet"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
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
