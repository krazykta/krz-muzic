package com.krazykta.krzmuzic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.DefaultMediaNotificationProvider
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

    private companion object { const val CHANNEL = "krz_musica" }

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        // Canal propio "Música": el de Media3 es de importancia baja (silenciosa); este es normal,
        // pero sin sonido ni vibración.
        // Un canal ya creado no puede cambiar de importancia desde la app: por eso es un id nuevo.
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL, getString(R.string.channel_music), NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(CHANNEL)
                .setChannelName(R.string.channel_music)
                .build()
        )
        val player = KrzEngine.ensure(this)
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
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.release()
        session = null
        KrzEngine.release()
        super.onDestroy()
    }
}
