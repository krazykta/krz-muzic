package com.krazykta.krzmuzic

import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * KrzDownloader — el "cartero" de NewPipe.
 *
 * NewPipe Extractor sabe QUÉ pedirle a YouTube, pero no hace él las peticiones a internet:
 * espera que la app le dé un Downloader. Este usa HttpURLConnection, que viene con Android,
 * así no añadimos más librerías.
 */
class KrzDownloader private constructor() : Downloader() {

    companion object {
        /** Nos presentamos como un Firefox de escritorio, igual que hace la app NewPipe. */
        const val USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"

        @JvmStatic
        val instance: KrzDownloader by lazy { KrzDownloader() }
    }

    override fun execute(request: Request): Response {
        val url = request.url()
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.requestMethod = request.httpMethod()
        conn.setRequestProperty("User-Agent", USER_AGENT)

        // Cabeceras que pide NewPipe (idioma, tipo de contenido, etc.)
        request.headers().forEach { (name, values) ->
            if (values.isNotEmpty()) {
                conn.setRequestProperty(name, values[0])
                values.drop(1).forEach { conn.addRequestProperty(name, it) }
            }
        }

        // Algunas peticiones envían datos (POST con JSON)
        request.dataToSend()?.let { body ->
            conn.doOutput = true
            conn.outputStream.use { it.write(body) }
        }

        try {
            val code = conn.responseCode
            if (code == 429) {
                // 429 = "demasiadas peticiones": YouTube quiere un captcha
                throw ReCaptchaException("reCaptcha Challenge requested", url)
            }
            val raw: InputStream? = if (code >= 400) conn.errorStream else conn.inputStream
            val stream = if (raw != null && conn.contentEncoding.equals("gzip", ignoreCase = true)) {
                GZIPInputStream(raw)
            } else raw
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            // La primera "cabecera" de HttpURLConnection tiene nombre null (es la línea de estado): fuera
            val headers = conn.headerFields.filterKeys { it != null }
            return Response(code, conn.responseMessage, headers, body, conn.url.toString())
        } catch (e: Exception) {
            conn.disconnect()
            throw e
        }
        // Sin disconnect() al ir bien: como ya hemos leído toda la respuesta, Android guarda la
        // conexión abierta ("keep-alive") y la siguiente petición a YouTube se ahorra conectar de nuevo.
    }
}
