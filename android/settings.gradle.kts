// settings.gradle.kts — dice a Gradle (la herramienta que compila la app) qué módulos tiene el proyecto
// y de dónde descargar las librerías.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io") // aquí estará la librería de NewPipe (etapa 2)
    }
}
rootProject.name = "KRZMuzic"
include(":app")
