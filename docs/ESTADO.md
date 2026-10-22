# Estado del proyecto (21/10/2026): cerrado

La app está terminada y limpia. Este documento resume qué hay y qué tener en cuenta si se retoma.

## Qué hay
- **Web/PWA** en GitHub Pages: buscador con autocompletado, playlists propias, importar playlists de YouTube,
  Me gusta, recomendaciones, copia de seguridad, diseño oscuro verde flúor con animaciones
  (que se apagan con "reducir movimiento").
- **App Android** (APK por GitHub Actions): la misma web en un WebView + motor nativo NewPipe + ExoPlayer.
  Sin anuncios, suena con la pantalla bloqueada, notificación con controles (canal «Música») y cápsula del
  notch en HyperOS. Copia de seguridad con "Guardar como" de Android. Aviso de permisos al abrir
  (notificaciones y batería sin restricciones).

## Decisiones y hallazgos que conviene recordar
- `NotificationPlayer` (KrzEngine) reenvía los avisos con un `Proxy`: `Player.Listener by listener` de Kotlin no
  reenvía los métodos "default" de Java y Media3 creía que no sonaba nada (sin notificación).
- Canal de notificación propio `krz_musica` (importancia normal, sin sonido): el de Media3 es de importancia baja.
- **Pantalla de bloqueo sin reproductor en el Xiaomi del usuario (HyperOS, Android 16):** tampoco sale con
  ninguna otra app de música. Es cosa del sistema, no de la app.
- Tras una pausa larga Android apaga el servicio: el motor guarda canción y segundo (`parked`) y los recupera al reanudar.
- Canciones que YouTube no deja oír (edad, borradas, privadas): el motor las salta (`unplayable`).
- Las últimas 20 canciones se recuerdan 1 h (`StreamResolver`): volver a una no pregunta otra vez a YouTube.
- Servidores del buscador (21/10): Piped `api.piped.private.coffee`, `pipedapi.ducks.party`, `pipedapi.wireway.ch`
  (+ `pipedapi.kavin.rocks` de reserva); Invidious `invidious.f5.si`, `invidious.flokinet.to`.
  Si caen: https://github.com/jayxdcode/piped-instances y la lista oficial de Piped. Probar cada uno con
  `/search?q=test&filter=music_songs` desde el navegador (CORS).
- El registro de diagnóstico (KrzLog y la pantalla "Diagnóstico") se quitó al cerrar el proyecto.
  Si vuelve a haber cortes, se puede recuperar del historial de git (commit anterior a la limpieza).

## Si se retoma
- Lista de cosas pendientes de arreglar: [SIGUIENTE-VERSION.md](SIGUIENTE-VERSION.md).
- NewPipe se rompe cuando YouTube cambia: actualizar la versión en `android/app/build.gradle.kts`.
- La clave de firma y sus contraseñas están en el repositorio (`android/app/krz-muzic.keystore` y
  `build.gradle.kts`). Moverlas a GitHub Secrets antes de compartir la app o hacer público el código.
- La carpeta antigua del PC (C:\Users\Usuario\Desktop\PR\KRZ_muzic) está desfasada: usar este repositorio.
