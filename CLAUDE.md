# KRZ Muzic — instrucciones para Claude Code

Reproductor de música personal (uso privado, sin distribución) basado en YouTube.
Dos piezas en este repositorio:

1. **Web / PWA** (raíz del repo): HTML + CSS + JavaScript "a pelo" (módulos ES, sin frameworks
   ni compilación). Publicada en GitHub Pages: https://krazykta.github.io/krz-muzic/
2. **App Android** (`android/`): Kotlin. Un WebView que carga la web publicada + un motor de audio
   nativo (sin anuncios y en segundo plano). GitHub Actions compila el APK en cada push que toque
   `android/**` y lo publica en https://github.com/krazykta/krz-muzic/releases/download/apk/krz-muzic.apk

## Cómo trabajar con el usuario (MUY IMPORTANTE)

- Responde **siempre en español**.
- El usuario está **aprendiendo a programar** con IA. Actúa como arquitecto, programador senior y profesor:
  - Explica la arquitectura y el plan **antes** de escribir código. Fases pequeñas; no avances hasta que la actual funcione.
  - Explica cada término técnico nuevo (qué es, para qué sirve, ejemplo). No repitas los que ya conoce.
  - Al dar o cambiar código: qué archivo, para qué sirve, qué hace cada bloque importante, cómo probarlo y qué resultado esperar.
  - Ante un error: identifica el problema, explica la causa, dónde está, propone solución y luego corrige.
  - Si su planteamiento es incorrecto, díselo y explica por qué.
  - Al terminar cada fase, una **mini prueba** (1–2 preguntas) **bien explicada**, con pistas.
- Sé honesto: distingue lo comprobado de lo supuesto. Nada de secretos/contraseñas en el código.
- Pide confirmación antes de acciones destructivas o difíciles de deshacer.

## Estructura

```
index.html            Esqueleto: splash, barra lateral, buscador, vista, panel "Ahora suena", tabbar móvil
css/styles.css        Estilos. Tokens en :root (--neon:#39ff14 verde flúor, fondo #08080a, fuente Nunito)
js/app.js             Interfaz: rutas (#/home, #/search/q, #/foryou, #/songs, #/likes, #/playlists,
                      #/playlist/ID, #/remote/LISTID, #/diag), vistas, buscador con autocompletado, acciones
js/player.js          Cola (aleatorio, repetir) + dos motores intercambiables:
                        - youtubeBackend: iframe de YouTube (navegador)
                        - nativeBackend: window.KRZNative (app Android)
js/catalog.js         Búsqueda sin claves: Piped (api.piped.private.coffee) e Invidious (invidious.f5.si)
js/recommend.js       Recomendaciones según lo escuchado + slider "populares" de Inicio
js/store.js           Datos en localStorage (krz-muzic:v1, krz-muzic:session)
js/youtube.js         API del iframe de YouTube, títulos (oEmbed/noembed), limpieza de títulos
js/ui.js, icons.js    Utilidades de interfaz (toast, menús, diálogos) e iconos SVG
sw.js                 Service worker "primero la red". ¡Sube el número de CACHE en cada versión!
manifest.webmanifest  Datos de la PWA
android/app/src/main/java/com/krazykta/krzmuzic/
  MainActivity.kt        WebView + puente KRZNative (play, setUpcoming, pause, resume, seek, next,
                         setVolume, setRepeatOne, stop, state, getLog, clearLog, share, deviceInfo)
  KrzEngine.kt           Motor: ExoPlayer (Media3), cola nativa de "próximas" canciones, eventos a la web
                         (state, time, advanced, ended, error, next, prev), registro de diagnóstico
  PlaybackService.kt     MediaSessionService: servicio en primer plano + notificación/pantalla de bloqueo
  StreamResolver.kt      NewPipe Extractor → audio de YouTube → MediaSource DASH (o progresivo)
  YoutubeHttpDataSource.java  Copiado de NewPipe (GPL-3) y portado a Media3
  KrzDownloader.kt       Downloader de NewPipe con HttpURLConnection
  KrzLog.kt              Registro en archivo con etiquetas [CORTE] [RED] [PAUSA] [ERROR] [CARGA] [WEB] [BOTÓN] [SISTEMA]
```

## Cómo se comunican web y Android

- La web detecta la app por `window.KRZNative` (y el user agent contiene `KRZMuzicApp/2`).
- La WEB decide qué suena (cola). Android decide cómo suena. La web envía por adelantado las
  próximas 30 canciones (`setUpcoming`) para que Android siga solo con la pantalla bloqueada.
- Android avisa a la web con `window.__krzNative(tipo, datos)`.
- Los cambios de la web llegan a la app sin reinstalar (la app carga GitHub Pages).
  Los cambios en `android/` necesitan instalar el APK nuevo.

## Versiones y compilación

- Android: AGP 8.5.2, Kotlin 1.9.24, Gradle 8.9, compileSdk/targetSdk 34, minSdk 24, Java 17,
  Media3 1.4.1, NewPipeExtractor v0.26.5 (JitPack), desugaring `desugar_jdk_libs_nio:2.0.4`.
- No hay SDK de Android en local: **se compila en GitHub Actions** (`.github/workflows/android.yml`).
  Para ver si compila: push a `main` y mirar la pestaña Actions.
- Firma: `android/app/krz-muzic.keystore` (alias `krz`, contraseña en build.gradle.kts). Es público a
  sabiendas (app personal). Si se comparte la app, moverlo a GitHub Secrets.
- `versionCode` = número de ejecución de GitHub Actions (sube solo).
- Probar la web en local: `python -m http.server 8000` en la raíz (o `iniciar.bat`) y abrir http://localhost:8000

## Estado actual y pendientes

Ver `docs/ESTADO.md`.
