package com.krazykta.krzmuzic

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * PlaybackService — un "servicio en primer plano".
 *
 * Una Activity (la pantalla) puede dormirse cuando bloqueas el móvil; un servicio de este tipo
 * no: Android lo mantiene vivo mientras suena música, a cambio de mostrar una notificación fija.
 *
 * Media3 hace casi todo el trabajo: con una "MediaSession" (sesión multimedia) crea la
 * notificación con carátula y botones, y los controles de la pantalla de bloqueo, de los
 * auriculares bluetooth y del coche.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = KrzEngine.ensure(this)
        KrzLog.d("[SISTEMA] Servicio de música iniciado")
        // Al tocar la notificación, abrimos la app
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(open)
            .build()
            .also { addSession(it) }   // así Media3 muestra la notificación sin esperar a nadie
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Si cierras la app deslizándola y no está sonando nada, apagamos el servicio. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        KrzLog.d("[SISTEMA] App quitada de recientes")
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        KrzLog.d("[SISTEMA] Servicio de música detenido")
        session?.release()
        session = null
        KrzEngine.release()
        super.onDestroy()
    }
}
