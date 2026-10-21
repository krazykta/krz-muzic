# Estado del proyecto (21/10/2026)

## Hecho y funcionando
- Web/PWA publicada en GitHub Pages: buscador tipo YouTube con autocompletado, playlists propias,
  importar playlists de YouTube, Me gusta, recomendaciones, slider adaptable, logo y paleta verde flúor.
- App Android (APK por GitHub Actions):
  - Etapa 1: WebView con la web. Instalada y funcionando (hubo que saltar Play Protect: "Más detalles → Instalar de todos modos").
  - Etapa 2: motor nativo NewPipe + ExoPlayer. **Confirmado por el usuario: sin anuncios y suena en segundo plano.**
  - Diagnóstico: registro en Biblioteca → "Diagnóstico de reproducción" (contadores + "Enviar registro").
    Colchón de audio de 1–5 min, 8 reintentos por trozo, reintentos con espera al resolver.

## Problema abierto (siguiente paso)
**La reproducción se interrumpe cada poco.**
- **Causa encontrada en el primer registro (21/10):** tras pausar, Android para el servicio ~60 s después
  (límites de segundo plano) y `KrzEngine.release()` olvidaba la canción. Al volver, "Reanudar" daba play
  a un reproductor vacío y no sonaba nada hasta cerrar y abrir la app. Ese registro no tenía `[CORTE]` ni `[ERROR]`.
- **Fase 1 (hecha, pendiente de probar en el móvil):** el motor guarda canción + segundo al apagarse
  (`parked`) y `resume()` la vuelve a pedir si el reproductor está vacío. También conserva volumen y repetir-una.
  Prueba: pausar, bloquear > 1 min, volver, play → debe sonar y salir `El motor se había apagado en la pausa`.
- **Fase 2 (opcional):** mantener el servicio vivo unos minutos en pausa para que reanude sin los ~1,5 s de carga.
- **Fase 3:** registro escuchando 15–20 min seguidos con pantalla bloqueada, sin pausar, para ver si hay
  cortes a mitad de canción (`[CORTE]` + `[RED]` = conexión/batería; `[PAUSA] otra app` = foco de audio;
  `[ERROR] HTTP 403` = direcciones de YouTube caducadas). Falta que el usuario diga cómo es el corte.

## Notificación, pantalla de bloqueo y cápsula del notch (en curso)
- Ventana flotante (PiP): **quitada** (21/10) a petición del usuario; quiere la cápsula del notch (Super Island de HyperOS 3).
- Primera APK de la revisión: al usuario no le salen la notificación, los controles en la pantalla de bloqueo ni el aviso
  de permisos. El aviso solo salía al abrir "de cero" y Android restaura la app tras actualizarla: ahora sale en cada arranque
  y mira `areNotificationsEnabled` (permiso + interruptor de Ajustes).
- `PlaybackService.onUpdateNotification` apunta `[SISTEMA] Notificación de música: primer plano …, notificaciones …`
  (o `[ERROR] Android no dejó poner la notificación`). Pedir ese registro al usuario.
- **Causa encontrada (registro del 21/10, Xiaomi 23078PND5G, Android 16):** `Notificación de música: primer plano no`
  y nunca cambiaba. `NotificationPlayer` (KrzEngine) envolvía los avisos con `Player.Listener by listener`, y Kotlin no
  reenvía los métodos "default" de Java: la sesión no se enteraba de que sonaba. Arreglado con un `Proxy` que reenvía todo.
  Pendiente de probar en el móvil: debe salir `primer plano sí` al sonar.
- Con el Proxy ya sale `primer plano sí` y Android tiene la notificación (id 1001, de música, pública), pero en un
  canal «Está sonando» de importancia 2 (baja = silenciosa) y HyperOS no la enseña en la pantalla de bloqueo.
  Ahora usa un canal propio «Música» (`krz_musica`, importancia normal, sin sonido ni vibración) y el registro
  apunta también si el sistema muestra las silenciosas en bloqueo. Pendiente de probar en el móvil.
- Cápsula: Xiaomi no tiene una API pública documentada; requiere primero que exista la notificación multimedia y,
  en HyperOS 3, permitir la app en Ajustes → Super Island. **Funciona (capturas del 21/10)** con el canal «Música»
  (importancia 3). Falta que el usuario confirme los controles en la pantalla de bloqueo.
- Canciones que YouTube no deja oír (edad, borradas, privadas → `ContentError`): antes el motor no preparaba ninguna
  detrás y, con la pantalla bloqueada, la música se paraba al acabar la actual. Ahora `KrzEngine` las apunta en
  `unplayable` y prepara la siguiente que sí se puede (`[CARGA] Me salto …`). Pendiente de probar en el móvil.

## Revisión general (en curso, sin subir: se sube todo junto al final)
- **Fase A — fallos (hecha, pendiente de probar en el móvil):**
  - Copia de seguridad en la app Android: antes no hacía nada (el WebView ignora descargas y `<input type=file>`).
    Ahora "Descargar copia" abre "Guardar como" de Android (`KRZNative.saveBackup` en `MainActivity.kt`) y
    "Restaurar copia" abre el selector de archivos (`onShowFileChooser`). En el navegador sigue igual que antes.
  - Carruseles: al redibujar la misma pantalla (cambio de canción, Me gusta…) ya no vuelven al principio
    (`renderView` en `js/app.js`). Probado en el navegador.
- **Fase B — limpieza (hecha):** fuera `androidx.webkit` (no se usaba), fuera `version()` y `stop()` del puente
  (la web nunca los llamaba), un solo `fetchJSON` (exportado desde `js/youtube.js`). README con la app Android.
  Búsqueda y títulos probados en el navegador.
- **Aviso de permisos al abrir (hecho, pendiente de probar en el móvil):** si faltan notificaciones o
  "batería sin restricciones", sale un aviso con Activar / Ahora no / No volver a preguntar, y Android pide
  cada uno (`checkPermissions` en `MainActivity.kt`). Cada arranque deja en el registro
  `[SISTEMA] Permisos: notificaciones …, batería sin restricciones …` (útil para los cortes).
  Lo demás (internet, servicio, ventana flotante) lo concede Android al instalar.
- **Fase C — conexión (hecha; Android pendiente de probar en el móvil):**
  - `KrzDownloader.kt`: reutiliza la conexión con YouTube (keep-alive) en vez de cerrarla en cada petición.
  - `StreamResolver.kt`: recuerda las últimas 20 canciones 1 h. Volver a una (atrás, repetir, reanudar
    tras pausa larga) sale casi al instante con `[CARGA] Audio desde la memoria`. Si esa dirección falla,
    `KrzEngine.play(isRetry)` la olvida y pide una nueva.
  - `js/catalog.js`: pregunta a los servidores de 2 en 2 (gana el primero que contesta) y espera menos
    (Piped 5 s, Invidious 7 s). Probado en el navegador, también con el servidor favorito colgado.
  - **Servidores revisados (21/10):** probados ~350 candidatos desde el navegador (lista oficial de Piped,
    api.invidious.io, Farside, LibRedirect, direcciones sueltas en código de GitHub y nombres típicos tipo
    `pipedapi.<dominio>`). Funcionan 5:
    - Piped: `api.piped.private.coffee`, `pipedapi.ducks.party` y `pipedapi.wireway.ch` (este no está en
      la lista oficial). `pipedapi.kavin.rocks` (oficial, caído) se queda de reserva.
    - Invidious: `invidious.f5.si` e `invidious.flokinet.to` (tampoco está en la lista oficial; abre
      playlists en ~1,4 s frente a los 8–11 s de f5.si).
    - Probado con servidores "colgados" a propósito: caen 2 Piped → responde wireway (5,5 s); caen los 3 →
      responde Invidious (10,7 s); cae f5.si → playlist desde flokinet (1,1 s).
  - Si vuelven a caer: https://github.com/jayxdcode/piped-instances (se regenera sola cada día) y la lista
    oficial de Piped. Probar cada uno con `/search?q=test&filter=music_songs` desde el navegador (CORS).
- **Fase D — diseño (hecha, probada en el navegador a 375 px y en escritorio):**
  - Cambio de pantalla con un fundido corto (`#view.enter`) y botones que "se hunden" al pulsarlos.
  - Latido del corazón al dar Me gusta (`beat()` en `js/app.js`).
  - Esqueletos (formas grises con brillo) mientras busca y mientras carga "Lo que suena".
  - Puntos bajo el carrusel: marcan dónde estás y se pueden tocar.
  - "Ahora suena" en el móvil: se tiñe del color de la portada (`setTint()`, variable CSS `--tint`),
    sube al abrirse, tiene una rayita arriba y se cierra deslizando hacia abajo (más de 110 px).
  - Barra de abajo en el móvil: deslizar a la izquierda = siguiente, a la derecha = anterior.
  - Con "reducir movimiento" activado en el sistema, todas estas animaciones se apagan.
  - Caché de la web subida a `krz-muzic-v20`.
- Fase E (subir y compilar): pendiente.

## Ideas pendientes / mejoras
- Mini prueba pendiente de responder (cortes y colchón; reparto web/Android).
- Mover la clave de firma a GitHub Secrets si algún día se comparte la app.
- NewPipe se rompe cuando YouTube cambia: actualizar la versión en `android/app/build.gradle.kts`.
- La carpeta antigua del PC (C:\Users\Usuario\Desktop\PR\KRZ_muzic) está desfasada: usar este repositorio.
