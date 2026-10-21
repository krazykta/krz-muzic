package com.krazykta.krzmuzic

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.exoplayer.dash.DashMediaSource
import androidx.media3.exoplayer.dash.DefaultDashChunkSource
import androidx.media3.exoplayer.dash.manifest.DashManifestParser
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.services.youtube.dashmanifestcreators.YoutubeProgressiveDashManifestCreator
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import java.io.ByteArrayInputStream
import java.io.IOException

/** Una canción tal como nos la describe la web: id de YouTube y datos para la notificación. */
data class Track(
    val id: String,
    val title: String? = null,
    val artist: String? = null,
    val thumb: String? = null,
)

/** El vídeo no se puede reproducir (privado, borrado, sin audio…). Reintentar no sirve. */
class ContentError(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * StreamResolver — convierte un id de YouTube en algo que ExoPlayer puede reproducir.
 *
 * Pasos (los mismos que hace la app NewPipe):
 *  1. NewPipe Extractor pide a YouTube la información del vídeo (desde TU móvil).
 *  2. Elegimos la pista de SOLO AUDIO de más calidad (no descargamos imagen: ahorra datos y batería).
 *  3. YouTube sirve ese audio en trozos; NewPipe genera un pequeño "índice" DASH para que
 *     ExoPlayer lo pida trozo a trozo, que es como YouTube acepta servirlo.
 *
 * ¡Ojo! Es una operación de red: SIEMPRE se llama desde un hilo secundario, nunca desde el principal.
 */
object StreamResolver {

    @Volatile private var initialized = false

    private fun ensureInit() {
        if (initialized) return
        synchronized(this) {
            if (!initialized) {
                NewPipe.init(KrzDownloader.instance, Localization("es", "ES"), ContentCountry("ES"))
                initialized = true
            }
        }
    }

    /** Resultado: lo que reproduce ExoPlayer + una descripción para el registro. */
    class Resolved(val source: MediaSource, val info: String)

    // Si falla la descarga de un trozo (p. ej. un bache de cobertura), ExoPlayer lo reintenta
    // hasta 8 veces antes de rendirse (por defecto son 3). Mientras, sigue sonando lo ya descargado.
    private val patientRetries = DefaultLoadErrorHandlingPolicy(8)

    // "Fuentes de datos": cómo descarga ExoPlayer los trozos de audio de YouTube.
    // range=true → pide los trozos con el parámetro &range= que usa YouTube; rn → número de petición.
    private val dashFactory by lazy {
        val ds = YoutubeHttpDataSource.Factory()
            .setRangeParameterEnabled(true)
            .setRnParameterEnabled(true)
        DashMediaSource.Factory(DefaultDashChunkSource.Factory(ds), ds)
            .setLoadErrorHandlingPolicy(patientRetries)
    }
    private val progressiveFactory by lazy {
        val ds = YoutubeHttpDataSource.Factory()
            .setRangeParameterEnabled(false)
            .setRnParameterEnabled(true)
        ProgressiveMediaSource.Factory(ds)
            .setLoadErrorHandlingPolicy(patientRetries)
    }

    /**
     * Lanza IOException si es un problema de red (merece la pena reintentar)
     * o ContentError si el vídeo en sí no se puede reproducir.
     */
    fun resolve(track: Track): Resolved {
        ensureInit()
        val info = try {
            StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=${track.id}")
        } catch (e: IOException) {
            throw e
        } catch (e: Exception) {
            throw ContentError("${e.javaClass.simpleName}: ${e.message}", e)
        }

        val audio = info.audioStreams.filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
        // Algunos vídeos traen varias pistas (doblajes): preferimos la original
        val original = audio.filter { it.audioTrackType == null || it.audioTrackType == AudioTrackType.ORIGINAL }
        val best = original.ifEmpty { audio }.maxByOrNull { it.averageBitrate }
            ?: throw ContentError("Este vídeo no tiene pista de audio disponible")
        val desc = "${best.format?.name ?: "?"} ${best.averageBitrate} kbps"

        // Datos para la notificación y la pantalla de bloqueo
        val meta = MediaMetadata.Builder()
            .setTitle(track.title ?: info.name)
            .setArtist(track.artist ?: info.uploaderName)
            .setArtworkUri(Uri.parse(track.thumb ?: "https://i.ytimg.com/vi/${track.id}/hqdefault.jpg"))
            .build()
        val item = MediaItem.Builder()
            .setMediaId(track.id)
            .setUri(best.content)
            .setMediaMetadata(meta)
            .build()

        return try {
            val manifest = YoutubeProgressiveDashManifestCreator.fromProgressiveStreamingUrl(
                best.content, requireNotNull(best.itagItem), info.duration,
            )
            val parsed = DashManifestParser().parse(
                Uri.parse(""), ByteArrayInputStream(manifest.toByteArray(Charsets.UTF_8)),
            )
            Resolved(dashFactory.createMediaSource(parsed, item), "$desc, por trozos (DASH)")
        } catch (e: Exception) {
            // Plan B: reproducirlo como un archivo normal
            Resolved(progressiveFactory.createMediaSource(item), "$desc, archivo completo")
        }
    }
}
