package com.krazykta.krzmuzic

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.exoplayer.dash.DashMediaSource
import androidx.media3.exoplayer.dash.DefaultDashChunkSource
import androidx.media3.exoplayer.dash.manifest.DashManifestParser
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
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

    // "Fuentes de datos": cómo descarga ExoPlayer los trozos de audio de YouTube.
    // range=true → pide los trozos con el parámetro &range= que usa YouTube; rn → número de petición.
    private val dashFactory by lazy {
        val ds = YoutubeHttpDataSource.Factory()
            .setRangeParameterEnabled(true)
            .setRnParameterEnabled(true)
        DashMediaSource.Factory(DefaultDashChunkSource.Factory(ds), ds)
    }
    private val progressiveFactory by lazy {
        val ds = YoutubeHttpDataSource.Factory()
            .setRangeParameterEnabled(false)
            .setRnParameterEnabled(true)
        ProgressiveMediaSource.Factory(ds)
    }

    @Throws(IOException::class)
    fun resolve(track: Track): MediaSource {
        ensureInit()
        val info = try {
            StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=${track.id}")
        } catch (e: Exception) {
            throw IOException("No se pudo leer el vídeo: ${e.message}", e)
        }

        val audio = info.audioStreams.filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
        // Algunos vídeos traen varias pistas (doblajes): preferimos la original
        val original = audio.filter { it.audioTrackType == null || it.audioTrackType == AudioTrackType.ORIGINAL }
        val best = original.ifEmpty { audio }.maxByOrNull { it.averageBitrate }
            ?: throw IOException("Este vídeo no tiene pista de audio disponible")

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
            dashFactory.createMediaSource(parsed, item)
        } catch (e: Exception) {
            // Plan B: reproducirlo como un archivo normal
            progressiveFactory.createMediaSource(item)
        }
    }
}
