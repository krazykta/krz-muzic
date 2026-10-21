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
        // "Desugaring": traduce funciones modernas de Java para que funcionen en Android antiguos.
        // La librería de NewPipe lo necesita en móviles con Android 12 o anterior.
        isCoreLibraryDesugaringEnabled = true
    }

    // Media3 marca parte de su código como "inestable" (puede cambiar entre versiones).
    // Lo usamos a sabiendas, así que le decimos al revisor (lint) que no lo trate como error.
    lint {
        disable += "UnsafeOptInUsageError"
        checkReleaseBuilds = false
    }

    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Etapa 2: audio nativo
    // NewPipe Extractor: obtiene desde el móvil la dirección del audio de cada vídeo (sin anuncios)
    implementation("com.github.TeamNewPipe:NewPipeExtractor:v0.26.5")
    // Media3: el reproductor oficial de Android (ExoPlayer) + notificación y pantalla de bloqueo
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-dash:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.0.4")
}
