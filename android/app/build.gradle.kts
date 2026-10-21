// Configuración de la app Android
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.krazykta.krzmuzic"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.krazykta.krzmuzic"   // el "DNI" de la app en Android
        minSdk = 24                                 // Android 7 o superior
        targetSdk = 34
        // El número de versión sube solo en cada compilación de GitHub (así Android acepta la actualización)
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"
    }

    // Firma: Android solo instala apps firmadas, y solo acepta una actualización
    // si viene firmada con la MISMA clave. Por eso usamos siempre esta.
    signingConfigs {
        create("krz") {
            storeFile = file("krz-muzic.keystore")
            storePassword = "krzmuzic"
            keyAlias = "krz"
            keyPassword = "krzmuzic"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("krz")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("krz")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
