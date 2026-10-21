package com.krazykta.krzmuzic

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * KrzEngine — el motor de audio nativo. Hay uno solo en toda la app (por eso es un "object").
 *
 * Reparto de tareas:
 *  - La WEB (player.js) decide QUÉ suena: cola, aleatorio, repetir.
 *  - El MOTOR decide CÓMO suena: busca el audio, lo reproduce con ExoPlayer y avisa a la web.
 *
 * Para que la música siga con la pantalla bloqueada, la web nos manda por adelantado la lista de
 * las próximas canciones ("upcoming"). Así el motor puede pasar de canción él solo aunque la
 * web esté dormida: siempre tiene la siguiente ya preparada detrás de la actual.
 *
 * Regla de oro: ExoPlayer solo se toca desde el hilo principal ("main").
 */
@OptIn(UnstableApi::class)
object KrzEngine {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()   // hilo para las peticiones de red

    private var exo: ExoPlayer? = null
    /** El reproductor que ve la notificación (con botones siguiente/anterior siempre activos). */
    var sessionPlayer: Player? = null
        private set

    /** Quién escucha los eventos (la pantalla con la web). Recibe (tipo, datosJSON). */
    var listener: ((String, String) -> Unit)? = null

    private var current: Track? = null
    private var upcoming: List<Track> = emptyList()
    private var preparedNextId: String? = null
    private var loadToken = 0       // cada play() nuevo invalida las búsquedas anteriores
    private var nextToken = 0
    private var retried = false

    /** Último estado conocido, para que la web lo consulte al abrirse. */
    @Volatile var snapshot: String = "{}"
        private set

    // ---------------------------------------------------------------- creación

    fun ensure(context: Context): Player {
        sessionPlayer?.let { return it }
        val app = context.applicationContext
        val player = ExoPlayer.Builder(app)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true,                                   // pausa si entra una llamada u otra app suena
            )
            .setHandleAudioBecomingNoisy(true)          // pausa si desconectas los auriculares
            .setWakeMode(C.WAKE_MODE_NETWORK)           // mantiene CPU y wifi despiertos al sonar
            .build()
        player.addListener(events)
        exo = player
        val wrapped = NotificationPlayer(player)
        sessionPlayer = wrapped
        main.post(ticker)
        return wrapped
    }

    fun release() {
        main.removeCallbacks(ticker)
        exo?.release()
        exo = null
        sessionPlayer = null
        current = null
        preparedNextId = null
    }

    // ---------------------------------------------------------------- órdenes (desde la web)

    /** Reproduce una canción desde cero. */
    fun play(track: Track, startSec: Double = 0.0, autoplay: Boolean = true, isRetry: Boolean = false) {
        val token = ++loadToken
        current = track
        retried = isRetry
        preparedNextId = null
        emit("state", JSONObject().put("state", "buffering").put("id", track.id))
        io.execute {
            try {
                val source = StreamResolver.resolve(track)
                main.post {
                    val p = exo ?: return@post
                    if (token != loadToken) return@post   // mientras tanto pediste otra canción
                    p.setMediaSource(source, (startSec * 1000).toLong())
                    p.prepare()
                    p.playWhenReady = autoplay
                    prepareNext()
                }
            } catch (e: Exception) {
                main.post {
                    if (token == loadToken) {
                        emit("error", JSONObject().put("id", track.id).put("message", e.message ?: "error"))
                    }
                }
            }
        }
    }

    /** La web nos dice qué canciones vienen después (ya con el aleatorio y la repetición aplicados). */
    fun setUpcoming(list: List<Track>) {
        upcoming = list
        val p = exo ?: return
        if (preparedNextId != list.firstOrNull()?.id) {
            // La siguiente preparada ya no es la correcta: la quitamos y preparamos la buena
            val idx = p.currentMediaItemIndex
            if (p.mediaItemCount > idx + 1) p.removeMediaItems(idx + 1, p.mediaItemCount)
            preparedNextId = null
            prepareNext()
        }
    }

    fun pause() { exo?.pause() }
    fun resume() { exo?.let { if (it.playbackState == Player.STATE_ENDED) it.seekTo(0); it.play() } }
    fun seek(sec: Double) { exo?.seekTo((sec * 1000).toLong()); tick() }
    fun setVolume(v: Int) { exo?.volume = (v.coerceIn(0, 100)) / 100f }
    fun setRepeatOne(on: Boolean) { exo?.repeatMode = if (on) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF }
    fun stop() { ++loadToken; exo?.stop(); exo?.clearMediaItems(); current = null; preparedNextId = null }

    /** Botón "siguiente" (de la notificación o de la web). */
    fun next() {
        val p = exo ?: return
        when {
            p.hasNextMediaItem() -> p.seekToNextMediaItem()           // ya estaba preparada: al instante
            upcoming.isNotEmpty() -> {                                 // aún no: la buscamos
                val t = upcoming.first()
                upcoming = upcoming.drop(1)
                play(t)
                emit("advanced", JSONObject().put("id", t.id))
            }
            else -> emit("next", JSONObject())                         // que decida la web
        }
    }

    /** Botón "anterior": si llevas más de 3 s vuelve al principio; si no, le pide a la web la anterior. */
    fun prev() {
        val p = exo ?: return
        if (p.currentPosition > 3000) p.seekTo(0) else emit("prev", JSONObject())
    }

    // ---------------------------------------------------------------- internos

    /** Busca y deja preparada la siguiente canción detrás de la actual. */
    private fun prepareNext() {
        val p = exo ?: return
        val next = upcoming.firstOrNull() ?: return
        if (preparedNextId == next.id || p.mediaItemCount > p.currentMediaItemIndex + 1) return
        val token = ++nextToken
        val forLoad = loadToken
        io.execute {
            val source = try { StreamResolver.resolve(next) } catch (e: Exception) { null }
            main.post {
                val pl = exo ?: return@post
                if (source == null || token != nextToken || forLoad != loadToken) return@post
                if (upcoming.firstOrNull()?.id != next.id) return@post
                if (pl.mediaItemCount > pl.currentMediaItemIndex + 1) return@post
                pl.addMediaSource(source)
                preparedNextId = next.id
            }
        }
    }

    private val events = object : Player.Listener {
        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            if (item == null || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) return
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) return
            // Ha pasado sola (o con "siguiente") a la canción que teníamos preparada
            val p = exo ?: return
            val id = item.mediaId
            current = upcoming.firstOrNull { it.id == id } ?: Track(id)
            if (upcoming.firstOrNull()?.id == id) upcoming = upcoming.drop(1)
            preparedNextId = null
            retried = false
            // Quitamos de la lista interna las canciones ya terminadas
            val idx = p.currentMediaItemIndex
            if (idx > 0) p.removeMediaItems(0, idx)
            emit("advanced", JSONObject().put("id", id))
            prepareNext()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) = sendState()
        override fun onPlaybackStateChanged(state: Int) {
            sendState()
            if (state == Player.STATE_ENDED) emit("ended", JSONObject())
        }

        override fun onPlayerError(error: PlaybackException) {
            val p = exo
            val cur = current
            // Las direcciones de YouTube caducan: si falla, volvemos a pedirla una vez
            if (!retried && cur != null && p != null) {
                play(cur, p.currentPosition / 1000.0, autoplay = true, isRetry = true)
                return
            }
            emit("error", JSONObject().put("id", cur?.id ?: "").put("message", error.errorCodeName))
        }
    }

    private fun sendState() {
        val p = exo ?: return
        val s = when {
            p.isPlaying -> "playing"
            p.playbackState == Player.STATE_BUFFERING && p.playWhenReady -> "buffering"
            p.playbackState == Player.STATE_ENDED -> "ended"
            else -> "paused"
        }
        emit("state", JSONObject().put("state", s).put("id", current?.id ?: ""))
    }

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            main.postDelayed(this, 500)
        }
    }

    private fun tick() {
        val p = exo ?: return
        val d = if (p.duration == C.TIME_UNSET) 0.0 else p.duration / 1000.0
        val t = p.currentPosition / 1000.0
        snapshot = JSONObject()
            .put("id", current?.id ?: "")
            .put("playing", p.isPlaying)
            .put("t", t).put("d", d)
            .toString()
        if (p.isPlaying) emit("time", JSONObject().put("t", t).put("d", d))
    }

    private fun emit(type: String, data: JSONObject) {
        listener?.invoke(type, data.toString())
    }

    /**
     * Envoltorio del reproductor para la notificación: hace que los botones
     * "siguiente" y "anterior" aparezcan siempre y que los gestione el motor.
     */
    private class NotificationPlayer(player: Player) : ForwardingPlayer(player) {
        private val extra = intArrayOf(
            COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        )
        private val wrappers = HashMap<Player.Listener, Player.Listener>()

        private fun augment(c: Player.Commands) = c.buildUpon().addAll(*extra).build()

        override fun getAvailableCommands(): Player.Commands = augment(super.getAvailableCommands())
        override fun isCommandAvailable(command: Int) = command in extra || super.isCommandAvailable(command)
        override fun hasNextMediaItem() = true
        override fun hasPreviousMediaItem() = true
        override fun seekToNext() = KrzEngine.next()
        override fun seekToNextMediaItem() = KrzEngine.next()
        override fun seekToPrevious() = KrzEngine.prev()
        override fun seekToPreviousMediaItem() = KrzEngine.prev()

        // Cuando el reproductor real avisa de qué botones hay, añadimos los nuestros
        override fun addListener(listener: Player.Listener) {
            val w = object : Player.Listener by listener {
                override fun onAvailableCommandsChanged(availableCommands: Player.Commands) =
                    listener.onAvailableCommandsChanged(augment(availableCommands))
            }
            wrappers[listener] = w
            super.addListener(w)
        }

        override fun removeListener(listener: Player.Listener) {
            super.removeListener(wrappers.remove(listener) ?: listener)
        }
    }
}
