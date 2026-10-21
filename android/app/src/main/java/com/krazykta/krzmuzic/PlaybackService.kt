package com.krazykta.krzmuzic

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.annotation.OptIn
import androidx.core.app.NotificationManagerCompat
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

    /**
     * Media3 llama aquí cada vez que pone o actualiza la notificación (play, pausa, canción nueva).
     * Lo apuntamos en el registro solo cuando cambia algo: así sabremos si Android la llega a mostrar.
     */
    private var lastNotif = ""
    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        val allowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
        val now = "primer plano ${if (startInForegroundRequired) "sí" else "no"}, notificaciones ${if (allowed) "permitidas" else "BLOQUEADAS"}"
        val changed = now != lastNotif
        if (changed) { lastNotif = now; KrzLog.d("[SISTEMA] Notificación de música: $now") }
        try {
            super.onUpdateNotification(session, startInForegroundRequired)
        } catch (e: Exception) {
            KrzLog.d("[ERROR] Android no dejó poner la notificación: ${e.javaClass.simpleName} ${e.message}")
            throw e
        }
        // Media3 la pone un momento después (espera a la carátula): miramos a los 3 s qué tiene Android de verdad
        if (changed) main.postDelayed({ logRealNotification() }, 3000)
    }

    private val main = Handler(Looper.getMainLooper())

    /** Diagnóstico: qué notificaciones de la app tiene Android activas y cómo está su categoría (canal). */
    private fun logRealNotification() {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            val active = nm.activeNotifications
            if (active.isEmpty()) {
                KrzLog.d("[SISTEMA] Notificación real: NINGUNA activa (Android no la tiene puesta)")
                return
            }
            for (sbn in active) {
                val n = sbn.notification
                val media = n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION)
                var line = "[SISTEMA] Notificación real: id ${sbn.id}, de música ${if (media) "sí" else "NO"}, " +
                    "visible bloqueado ${visibility(n.visibility)}, fija ${if (sbn.isOngoing) "sí" else "no"}"
                if (Build.VERSION.SDK_INT >= 26) {
                    val ch = nm.getNotificationChannel(n.channelId)
                    line += if (ch == null) ", canal «${n.channelId}» NO EXISTE" else
                        ", canal «${ch.name}»: importancia ${ch.importance}${if (ch.importance == NotificationManager.IMPORTANCE_NONE) " (BLOQUEADO)" else ""}" +
                        ", en pantalla de bloqueo ${visibility(ch.lockscreenVisibility)}"
                }
                KrzLog.d(line)
            }
            // Ajustes del sistema para la pantalla de bloqueo (algunos móviles no dejan leerlos)
            val show = runCatching { Settings.Secure.getInt(contentResolver, "lock_screen_show_notifications") }.getOrNull()
            val priv = runCatching { Settings.Secure.getInt(contentResolver, "lock_screen_allow_private_notifications") }.getOrNull()
            KrzLog.d("[SISTEMA] Pantalla de bloqueo: notificaciones ${show?.let { if (it == 1) "sí" else "NO" } ?: "?"}, " +
                "contenido ${priv?.let { if (it == 1) "visible" else "OCULTO" } ?: "?"}, sonando ${if (session?.player?.isPlaying == true) "sí" else "no"}")
        } catch (e: Exception) {
            KrzLog.d("[SISTEMA] No se pudo leer el estado de la notificación: ${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun visibility(v: Int) = when (v) {
        Notification.VISIBILITY_PUBLIC -> "sí (pública)"
        Notification.VISIBILITY_PRIVATE -> "a medias (privada)"
        Notification.VISIBILITY_SECRET -> "NO (secreta)"
        else -> "lo que diga el sistema"   // -1000: el canal no lo fija
    }

    /** Si cierras la app deslizándola y no está sonando nada, apagamos el servicio. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        KrzLog.d("[SISTEMA] App quitada de recientes")
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        KrzLog.d("[SISTEMA] Servicio de música detenido")
        main.removeCallbacksAndMessages(null)
        session?.release()
        session = null
        KrzEngine.release()
        super.onDestroy()
    }
}
