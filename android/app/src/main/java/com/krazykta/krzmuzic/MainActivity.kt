package com.krazykta.krzmuzic

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * MainActivity — la única pantalla de la app.
 *
 * Muestra KRZ Muzic dentro de un WebView: un navegador integrado en la app.
 * Carga la versión publicada en GitHub Pages, así que cada cambio que subamos
 * a GitHub aparece en la app sin reinstalar nada.
 *
 * Etapa 2: un "puente" (KrzBridge) deja que la web le pida a Android que reproduzca
 * el audio con su reproductor nativo (sin anuncios y en segundo plano), y le devuelve
 * los eventos (está sonando, tiempo, canción terminada…).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())

    companion object {
        const val APP_URL = "https://krazykta.github.io/krz-muzic/"
        const val APP_HOST = "krazykta.github.io"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#08080A"))
            settings.javaScriptEnabled = true          // la app está hecha en JavaScript
            settings.domStorageEnabled = true          // para guardar tus playlists (localStorage)
            settings.mediaPlaybackRequiresUserGesture = false // que la música pueda empezar sola
            // Añadimos una marca al "user agent" (la tarjeta de presentación del navegador)
            // para que la web sepa que está dentro de la app nativa
            settings.userAgentString = settings.userAgentString + " KRZMuzicApp/2"
            // El puente: en la web aparecerá como window.KRZNative
            addJavascriptInterface(KrzBridge(), "KRZNative")
            webChromeClient = WebChromeClient()
            webViewClient = KrzWebClient()
        }
        setContentView(web)

        // Preparamos el motor y conectamos sus eventos con la web
        KrzEngine.ensure(this)
        KrzLog.d("[SISTEMA] App abierta")
        KrzEngine.listener = { type, data ->
            main.post {
                web.evaluateJavascript(
                    "window.__krzNative && window.__krzNative(${org.json.JSONObject.quote(type)}, $data)", null,
                )
            }
        }
        askNotificationPermission()

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(APP_URL)

        // Botón "atrás" de Android: primero navega dentro de la app; si no hay a dónde volver, sale
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
    }

    // La pantalla se ve / deja de verse (bloqueo, cambiar de app…): útil para cruzarlo con los cortes
    override fun onStart() { super.onStart(); KrzLog.d("[SISTEMA] Pantalla de la app visible") }
    override fun onStop() { KrzLog.d("[SISTEMA] App en segundo plano o pantalla bloqueada"); super.onStop() }

    override fun onDestroy() {
        KrzLog.d("[SISTEMA] App cerrada")
        KrzEngine.listener = null
        web.destroy()
        super.onDestroy()
    }

    /** Android 13+ pide permiso para mostrar notificaciones (la de la música). */
    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    /** Arranca el servicio de música (si ya está arrancado, no pasa nada). */
    private fun startPlaybackService() {
        KrzEngine.ensure(this)
        startService(Intent(this, PlaybackService::class.java))
    }

    private fun parseTrack(o: org.json.JSONObject) = Track(
        id = o.getString("id"),
        title = o.optString("title").ifBlank { null },
        artist = o.optString("artist").ifBlank { null },
        thumb = o.optString("thumb").ifBlank { null },
    )

    /**
     * El puente entre la web y Android.
     * Cada función marcada con @JavascriptInterface se puede llamar desde JavaScript,
     * por ejemplo: KRZNative.pause()
     * Ojo: JavaScript las llama desde un hilo propio, así que pasamos cada orden al hilo
     * principal con main.post { … } antes de tocar el reproductor.
     */
    inner class KrzBridge {
        @JavascriptInterface fun version(): Int = 2

        /** Estado actual (para cuando reabres la app con música sonando). */
        @JavascriptInterface fun state(): String = KrzEngine.snapshot

        /** json: {id, title, artist, thumb, start, autoplay} */
        @JavascriptInterface fun play(json: String) {
            val o = org.json.JSONObject(json)
            val track = parseTrack(o)
            val start = o.optDouble("start", 0.0)
            val autoplay = o.optBoolean("autoplay", true)
            main.post {
                startPlaybackService()
                KrzEngine.play(track, start, autoplay)
            }
        }

        /** json: [{id, title, artist, thumb}, …] — las próximas canciones en orden */
        @JavascriptInterface fun setUpcoming(json: String) {
            val arr = org.json.JSONArray(json)
            val list = (0 until arr.length()).map { parseTrack(arr.getJSONObject(it)) }
            main.post { KrzEngine.setUpcoming(list) }
        }

        @JavascriptInterface fun pause() { KrzLog.d("[WEB] Pausa"); main.post { KrzEngine.pause() } }
        @JavascriptInterface fun resume() { KrzLog.d("[WEB] Reanudar"); main.post { startPlaybackService(); KrzEngine.resume() } }
        @JavascriptInterface fun seek(sec: Double) { KrzLog.d("[WEB] Saltar al segundo ${sec.toInt()}"); main.post { KrzEngine.seek(sec) } }
        @JavascriptInterface fun next() { main.post { KrzEngine.next() } }
        @JavascriptInterface fun setVolume(v: Int) { main.post { KrzEngine.setVolume(v) } }
        @JavascriptInterface fun setRepeatOne(on: Boolean) { main.post { KrzEngine.setRepeatOne(on) } }
        @JavascriptInterface fun stop() { main.post { KrzEngine.stop() } }

        // ---- Diagnóstico ----
        /** Devuelve el registro completo (texto). */
        @JavascriptInterface fun getLog(): String = KrzLog.read()
        @JavascriptInterface fun clearLog() { KrzLog.clear() }
        /** Abre el menú "Compartir" de Android con el registro (WhatsApp, correo, etc.). */
        @JavascriptInterface fun share(text: String) {
            main.post {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, "Registro de KRZ Muzic")
                    .putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(send, "Enviar registro"))
            }
        }
        /** Datos del móvil para el informe. */
        @JavascriptInterface fun deviceInfo(): String =
            "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private inner class KrzWebClient : WebViewClient() {
        /** Los enlaces de KRZ Muzic se abren dentro; los demás (YouTube, GitHub…) en el navegador. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.host == APP_HOST) return false
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())))
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                Toast.makeText(this@MainActivity, getString(R.string.offline), Toast.LENGTH_LONG).show()
            }
        }
    }
}
