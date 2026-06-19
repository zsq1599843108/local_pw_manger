plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.passman.pair"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.passman.pair"
        // AOAP UsbAccessory has been available since API 12, but we lift the floor
        // to 21 (Android 5.0) so we get unrestricted Kotlin stdlib + later (M4)
        // EncryptedSharedPreferences without legacy multidex pain.
        minSdk = 21
        targetSdk = 35
        versionCode = 1
        versionName = "0.3-m1"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // M1 ships unsigned debug only. M5 will add a real signing config.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // M1 doesn't need any layouts — the Activity uses contentless windows.
    buildFeatures {
        viewBinding = false
    }
}

dependencies {
    // Kept deliberately minimal for M1. Tink + EncryptedSharedPreferences land in M2/M4
    // (already noted in PROGRESS.md install-deps blocker).
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // BiometricPrompt — used by BiometricDemoActivity for fingerprint validation PoC.
    // Pre-empted from M3 (CHALLENGE/RESPONSE flow) so we hit OEM-specific landmines
    // (Xiaomi MIUI fingerprint quirks) before they block protocol work.
    implementation("androidx.biometric:biometric:1.2.0-alpha05")
}
