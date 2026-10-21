package com.krazykta.krzmuzic

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import org.json.JSONObject
import java.io.IOException
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.util.concurrent.ConcurrentHashMap
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
 * Todo lo importante se apunta en KrzLog (el registro), con etiquetas para poder contarlo:
 *  [CORTE] la música se para porque no tiene datos   [RED] cambios de conexión y fallos de descarga
 *  [PAUSA] alguien pausó (tú, otra app, auriculares)   [ERROR] fallos graves
 *  [CARGA] buscar el audio de una canción               [WEB]/[SISTEMA] órdenes y ciclo de vida
 *
 * Regla de oro: ExoPlayer solo se toca desde el hilo principal ("main").
 */
@OptIn(UnstableApi::class)
object KrzEngine {

    private val main = Handler(Looper.getMainLooper())
    private val ioNow = Executors.newSingleThreadExecutor()    // buscar la canción que pides ya
    private val ioNext = Executors.newSingleThreadExecutor()   // preparar la siguiente, sin estorbar

    private var exo: ExoPlayer? = null
    /** El reproductor que ve la notificación (con botones siguiente/anterior siempre activos). */
    var sessionPlayer: Player? = null
        private set

    /** Quién escucha los eventos (la pantalla con la web). Recibe (tipo, datosJSON). */
    var listener: ((String, String) -> Unit)? = null

    private var current: Track? = null
    private var upcoming: List<Track> = emptyList()
    private var preparedNextId: String? = null
    /** Canciones que YouTube no deja oír (edad, borradas, privadas): se saltan sin volver a pedirlas. */
    private val unplayable = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var loadToken = 0   // cada play() nuevo invalida las búsquedas anteriores
    @Volatile private var nextToken = 0
    private var errorRetries = 0          // reintentos tras error en la canción actual
    private var lastState = Player.STATE_IDLE
    private var stallStart = 0L           // cuándo empezó el corte actual (0 = no hay corte)
    private var networkWatched = false
    // Lo que queremos conservar aunque Android apague el motor (ver release y resume)
    private var parked: Pair<Track, Double>? = null   // canción y segundo al apagarse
    private var volume = 1f
    private var repeatMode = Player.REPEAT_MODE_OFF

    private const val MAX_ERROR_RETRIES = 3

    /** Último estado conocido, para que la web lo consulte al abrirse. */
    @Volatile var snapshot: String = "{}"
        private set

    // ---------------------------------------------------------------- creación

    fun ensure(context: Context): Player {
        sessionPlayer?.let { return it }
        val app = context.applicationContext
        KrzLog.init(app)
        watchNetwork(app)

        // Colchón de audio ("buffer"): cuánto descarga por adelantado.
        // Por defecto ExoPlayer guarda unos 50 s; para música subimos a 1-5 minutos
        // (son solo 1-5 MB), así un bache de cobertura no se nota.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                60_000,    // mínimo que intenta tener siempre por delante
                300_000,   // máximo que descarga por adelantado
                1_500,     // con cuánto empieza a sonar
                3_000,     // con cuánto vuelve a sonar tras un corte
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        val player = ExoPlayer.Builder(app)
            .setLoadControl(loadControl)
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
        player.addAnalyticsListener(downloads)
        player.volume = volume
        player.repeatMode = repeatMode
        exo = player
        val wrapped = NotificationPlayer(player)
        sessionPlayer = wrapped
        main.post(ticker)
        KrzLog.d("[SISTEMA] Motor de audio creado")
        return wrapped
    }

    fun release() {
        main.removeCallbacks(ticker)
        // Android para el servicio ~1 min después de pausar: apuntamos dónde íbamos para seguir luego
        parked = current?.let { t ->
            val p = exo
            t to if (p == null || p.playbackState == Player.STATE_ENDED) 0.0 else p.currentPosition / 1000.0
        }
        exo?.release()
        exo = null
        sessionPlayer = null
        current = null
        preparedNextId = null
        KrzLog.d("[SISTEMA] Motor de audio apagado")
    }

    // ---------------------------------------------------------------- órdenes (desde la web)

    /** Reproduce una canción desde cero. */
    fun play(track: Track, startSec: Double = 0.0, autoplay: Boolean = true, isRetry: Boolean = false) {
        val token = ++loadToken
        current = track
        parked = null
        if (!isRetry) errorRetries = 0
        else StreamResolver.forget(track.id)   // la dirección guardada ha fallado (caducada o 403): pedir otra
        preparedNextId = null
        stallStart = 0
        KrzLog.d("[CARGA] ${if (isRetry) "Reintento" else "Pido"}: ${label(track)}" +
            if (startSec > 0) " desde ${"%.0f".format(startSec)} s" else "")
        emit("state", JSONObject().put("state", "buffering").put("id", track.id))
        ioNow.execute {
            val t0 = SystemClock.elapsedRealtime()
            try {
                val r = resolveWithRetry(track) { token == loadToken }
                KrzLog.d("[CARGA] Audio listo en ${SystemClock.elapsedRealtime() - t0} ms (${r.info})")
                main.post {
                    val p = exo ?: return@post
                    if (token != loadToken) return@post   // mientras tanto pediste otra canción
                    p.setMediaSource(r.source, (startSec * 1000).toLong())
                    p.prepare()
                    p.playWhenReady = autoplay
                    prepareNext()
                }
            } catch (e: Exception) {
                if (e is ContentError) unplayable += track.id
                if (token != loadToken) return@execute
                KrzLog.d("[ERROR] No se pudo cargar ${label(track)}: ${describe(e)}")
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
        if (preparedNextId != firstPlayable()?.id) {
            // La siguiente preparada ya no es la correcta: la quitamos y preparamos la buena
            val idx = p.currentMediaItemIndex
            if (p.mediaItemCount > idx + 1) p.removeMediaItems(idx + 1, p.mediaItemCount)
            preparedNextId = null
            prepareNext()
        }
    }

    fun pause() { exo?.pause() }
    /** Seguir sonando. Si Android apagó el motor en la pausa, vuelve a pedir la canción donde iba. */
    fun resume() {
        val p = exo ?: return
        val saved = parked
        if (p.mediaItemCount == 0 && saved != null) {
            KrzLog.d("[SISTEMA] El motor se había apagado en la pausa: recupero la canción")
            play(saved.first, saved.second)
            return
        }
        if (p.playbackState == Player.STATE_ENDED) p.seekTo(0)
        p.play()
    }
    fun seek(sec: Double) { exo?.seekTo((sec * 1000).toLong()); tick() }
    fun setVolume(v: Int) { volume = (v.coerceIn(0, 100)) / 100f; exo?.volume = volume }
    fun setRepeatOne(on: Boolean) {
        repeatMode = if (on) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        exo?.repeatMode = repeatMode
    }

    /** Botón "siguiente" (de la notificación o de la web). */
    fun next() {
        val p = exo ?: return
        KrzLog.d("[BOTÓN] Siguiente")
        val t = firstPlayable()
        when {
            p.hasNextMediaItem() -> p.seekToNextMediaItem()           // ya estaba preparada: al instante
            t != null -> {                                             // aún no: la buscamos
                upcoming = upcoming.drop(upcoming.indexOf(t) + 1)
                play(t)
                emit("advanced", JSONObject().put("id", t.id))
            }
            else -> emit("next", JSONObject())                         // que decida la web
        }
    }

    /** Botón "anterior": si llevas más de 3 s vuelve al principio; si no, le pide a la web la anterior. */
    fun prev() {
        val p = exo ?: return
        KrzLog.d("[BOTÓN] Anterior")
        if (p.currentPosition > 3000) p.seekTo(0) else emit("prev", JSONObject())
    }

    // ---------------------------------------------------------------- internos

    /**
     * Busca el audio. Si falla por la RED (sin cobertura un momento), espera y lo vuelve a
     * intentar: 2 s, 4 s y 8 s. Si falla por el VÍDEO (borrado, privado…), no insiste.
     * Sin esto, un corte de conexión de 5 segundos haría saltar canciones una tras otra.
     */
    private fun resolveWithRetry(track: Track, stillWanted: () -> Boolean): StreamResolver.Resolved {
        var wait = 2_000L
        var attempt = 1
        while (true) {
            try {
                return StreamResolver.resolve(track)
            } catch (e: IOException) {
                if (attempt >= 4 || !stillWanted()) throw e
                KrzLog.d("[RED] Intento $attempt sin respuesta (${describe(e)}); reintento en ${wait / 1000} s")
                Thread.sleep(wait)
                if (!stillWanted()) throw e
                wait *= 2
                attempt++
            }
        }
    }

    private fun firstPlayable() = upcoming.firstOrNull { it.id !in unplayable }

    /** Busca y deja preparada la siguiente canción detrás de la actual (saltando las que no se pueden oír). */
    private fun prepareNext() {
        val p = exo ?: return
        val next = firstPlayable() ?: return
        if (preparedNextId == next.id || p.mediaItemCount > p.currentMediaItemIndex + 1) return
        val token = ++nextToken
        val forLoad = loadToken
        ioNext.execute {
            val r = try {
                resolveWithRetry(next) { token == nextToken && forLoad == loadToken }
            } catch (e: ContentError) {
                // No es la red, es el vídeo: insistir no sirve. La apuntamos y preparamos la de después.
                unplayable += next.id
                KrzLog.d("[CARGA] Me salto ${label(next)}: YouTube no deja oírla (${describe(e)})")
                main.post { if (token == nextToken && forLoad == loadToken) prepareNext() }
                return@execute
            } catch (e: Exception) {
                KrzLog.d("[CARGA] No se pudo preparar la siguiente (${label(next)}): ${describe(e)}")
                null
            }
            main.post {
                val pl = exo ?: return@post
                if (r == null || token != nextToken || forLoad != loadToken) return@post
                if (firstPlayable()?.id != next.id) return@post
                if (pl.mediaItemCount > pl.currentMediaItemIndex + 1) return@post
                pl.addMediaSource(r.source)
                preparedNextId = next.id
                KrzLog.d("[CARGA] Siguiente preparada: ${label(next)}")
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
            // Quitamos de "upcoming" esta y las que nos hemos saltado delante de ella
            val at = upcoming.indexOfFirst { it.id == id }
            if (at >= 0) upcoming = upcoming.drop(at + 1)
            preparedNextId = null
            errorRetries = 0
            KrzLog.d("[CARGA] Paso a la siguiente: ${label(current!!)}")
            // Quitamos de la lista interna las canciones ya terminadas
            val idx = p.currentMediaItemIndex
            if (idx > 0) p.removeMediaItems(0, idx)
            emit("advanced", JSONObject().put("id", id))
            prepareNext()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) = sendState()

        override fun onPlaybackStateChanged(state: Int) {
            val p = exo
            val now = SystemClock.elapsedRealtime()
            if (p != null) {
                if (state == Player.STATE_BUFFERING && lastState == Player.STATE_READY && p.playWhenReady) {
                    stallStart = now
                    KrzLog.d("[CORTE] Se ha quedado sin audio descargado en el segundo " +
                        "${p.currentPosition / 1000} (colchón: ${(p.bufferedPosition - p.currentPosition) / 1000} s)")
                }
                if (state == Player.STATE_READY && stallStart > 0) {
                    KrzLog.d("[CORTE] Vuelve a sonar tras ${"%.1f".format((now - stallStart) / 1000.0)} s parada")
                    stallStart = 0
                }
            }
            lastState = state
            sendState()
            if (state == Player.STATE_ENDED) {
                KrzLog.d("[CARGA] Fin: no hay más canciones preparadas")
                emit("ended", JSONObject())
            }
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val why = when (reason) {
                Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "botón (app, notificación o auriculares)"
                Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "otra app ha cogido el audio (vídeo, llamada, otra música)"
                Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "auriculares o altavoz bluetooth desconectados"
                Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "control remoto"
                Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "fin de la canción"
                else -> "motivo $reason"
            }
            KrzLog.d("[PAUSA] ${if (playWhenReady) "Reproducir" else "Pausa"}: $why")
        }

        override fun onPlaybackSuppressionReasonChanged(reason: Int) {
            if (reason == Player.PLAYBACK_SUPPRESSION_REASON_NONE) {
                KrzLog.d("[PAUSA] Fin del silencio temporal")
            } else {
                KrzLog.d("[PAUSA] Silencio temporal: otra app usa el audio un momento (aviso, asistente, llamada…)")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val p = exo
            val cur = current
            KrzLog.d("[ERROR] El reproductor se ha detenido: ${error.errorCodeName} — ${describe(error)}")
            // Las direcciones de YouTube caducan y la red falla: volvemos a pedirla (hasta 3 veces)
            if (errorRetries < MAX_ERROR_RETRIES && cur != null && p != null) {
                errorRetries++
                play(cur, p.currentPosition / 1000.0, autoplay = true, isRetry = true)
                return
            }
            emit("error", JSONObject().put("id", cur?.id ?: "").put("message", error.errorCodeName))
        }
    }

    /** Escucha las descargas: cada trozo que falla (ExoPlayer lo reintenta solo). */
    private val downloads = object : AnalyticsListener {
        override fun onLoadError(
            eventTime: AnalyticsListener.EventTime,
            loadEventInfo: LoadEventInfo,
            mediaLoadData: MediaLoadData,
            error: IOException,
            wasCanceled: Boolean,
        ) {
            KrzLog.d("[RED] Falló la descarga de un trozo (se reintenta): ${describe(error)}")
        }
    }

    /** Apunta en el registro cuándo cambia la conexión (wifi ↔ datos, sin cobertura…). */
    private fun watchNetwork(app: Context) {
        if (networkWatched) return
        networkWatched = true
        try {
            val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val caps = cm.getNetworkCapabilities(network)
                    val kind = when {
                        caps == null -> "red"
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "datos móviles"
                        else -> "otra red"
                    }
                    KrzLog.d("[RED] Conectado a $kind")
                }

                override fun onLost(network: Network) {
                    KrzLog.d("[RED] Conexión perdida")
                }
            })
        } catch (e: Exception) {
            KrzLog.d("[SISTEMA] No se pudo vigilar la red: ${e.message}")
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

    private fun label(t: Track) = "«${t.title ?: t.id}»"

    /** Resume un error y sus causas en una línea (p. ej. "HTTP 403 ← InvalidResponseCodeException"). */
    fun describe(e: Throwable): String {
        val parts = mutableListOf<String>()
        var c: Throwable? = e
        while (c != null && parts.size < 4) {
            parts += when (c) {
                is HttpDataSource.InvalidResponseCodeException -> "HTTP ${c.responseCode}"
                else -> "${c.javaClass.simpleName}${c.message?.let { ": ${it.take(120)}" } ?: ""}"
            }
            c = c.cause
        }
        return parts.joinToString(" ← ")
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

        /**
         * Cuando el reproductor real avisa de qué botones hay, añadimos los nuestros; el resto de avisos
         * (suena, pausa, canción nueva…) pasan tal cual. Usamos un "proxy" (objeto que Java crea al vuelo y
         * por el que pasan TODOS los métodos) porque `Player.Listener by listener` de Kotlin no reenvía los
         * métodos "default" de Java: se perdían esos avisos y Media3 creía que no sonaba nada (sin notificación).
         */
        override fun addListener(listener: Player.Listener) {
            val w = Proxy.newProxyInstance(Player.Listener::class.java.classLoader, arrayOf(Player.Listener::class.java)) { proxy, m, args ->
                when (m.name) {
                    "equals" -> proxy === args?.get(0)
                    "hashCode" -> System.identityHashCode(proxy)
                    "toString" -> "KrzListener($listener)"
                    "onAvailableCommandsChanged" -> listener.onAvailableCommandsChanged(augment(args!![0] as Player.Commands))
                    else -> try { m.invoke(listener, *(args ?: emptyArray<Any?>())) } catch (e: InvocationTargetException) { throw e.targetException }
                }
            } as Player.Listener
            wrappers[listener] = w
            super.addListener(w)
        }

        override fun removeListener(listener: Player.Listener) {
            super.removeListener(wrappers.remove(listener) ?: listener)
        }
    }
}
