package com.krazykta.krzmuzic

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * MainActivity — la única pantalla de la app (etapa 1).
 *
 * Muestra KRZ Muzic dentro de un WebView: un navegador integrado en la app.
 * Carga la versión publicada en GitHub Pages, así que cada cambio que subamos
 * a GitHub aparece en la app sin reinstalar nada.
 *
 * En la etapa 2 añadiremos aquí un "puente" para que la web le pida a Android
 * que reproduzca el audio con su reproductor nativo (sin anuncios y en segundo plano).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

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
            settings.userAgentString = settings.userAgentString + " KRZMuzicApp/1"
            webChromeClient = WebChromeClient()
            webViewClient = KrzWebClient()
        }
        setContentView(web)

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(APP_URL)

        // Botón "atrás" de Android: primero navega dentro de la app; si no hay a dónde volver, sale
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
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
