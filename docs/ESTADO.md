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
**La reproducción se interrumpe cada poco.** Causa sin confirmar.
1. El usuario debe instalar el último APK, poner la app en "Ahorro de batería → Sin restricciones"
   (si es Xiaomi), escuchar hasta tener 2–3 cortes y enviar el registro.
2. Pendiente que diga cómo es el corte: ¿se calla y vuelve sola, se queda en pausa, o salta canción?
3. Leer el registro: `[CORTE]` + `[RED]` = conexión/batería; `[PAUSA] otra app` = foco de audio;
   `[ERROR] HTTP 403` = direcciones de YouTube caducadas o bloqueadas; `[SISTEMA] Servicio detenido` = Android mató la app.
4. Solo después de saber la causa, arreglar.

## Ideas pendientes / mejoras
- Mini prueba pendiente de responder (cortes y colchón; reparto web/Android).
- Mover la clave de firma a GitHub Secrets si algún día se comparte la app.
- NewPipe se rompe cuando YouTube cambia: actualizar la versión en `android/app/build.gradle.kts`.
- README desactualizado (no explica la app Android).
- La carpeta antigua del PC (C:\Users\Usuario\Desktop\PR\KRZ_muzic) está desfasada: usar este repositorio.
