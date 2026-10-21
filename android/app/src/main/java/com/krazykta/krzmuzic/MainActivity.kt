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
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat

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

    // ---- Copia de seguridad ----
    // El WebView no sabe descargar archivos ni abrir el selector de archivos por su cuenta:
    // se lo hacemos nosotros con el selector de Android (sin pedir permisos de almacenamiento).

    /** Guardar: Android pregunta dónde y con qué nombre; luego escribimos ahí la copia. */
    private var pendingBackup: String? = null
    private val saveBackup = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val json = pendingBackup
        pendingBackup = null
        if (uri == null || json == null) return@registerForActivityResult   // has cancelado
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            KrzLog.d("[SISTEMA] Copia de seguridad guardada (${json.length / 1024} KB)")
            Toast.makeText(this, "Copia guardada", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            KrzLog.d("[ERROR] No se pudo guardar la copia de seguridad: ${e.message}")
            Toast.makeText(this, "No se pudo guardar la copia", Toast.LENGTH_LONG).show()
        }
    }

    /** Restaurar: la web pide un archivo (<input type="file">) y se lo damos con el selector de Android. */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
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
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)   // si había otro selector a medias, lo cancelamos
                    fileCallback = callback
                    // "*/*": muchos móviles no marcan los .json como JSON y saldrían en gris; la web ya comprueba el archivo
                    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    return try {
                        pickFile.launch(pick)
                        true
                    } catch (e: Exception) {
                        fileCallback = null
                        false
                    }
                }
            }
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
        // En cada arranque, también cuando Android "restaura" la app (p. ej. tras actualizarla)
        checkPermissions()

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

    // ---- Permisos ----
    // Internet y servicio en segundo plano los da Android al instalar.
    // Estos dos no: hay que pedirlos y el usuario dice sí o no en una ventana del sistema.

    /**
     * Notificaciones: sin ellas no sale la notificación con los controles de la música.
     * areNotificationsEnabled mira las dos cosas: el permiso (Android 13+) y el interruptor de Ajustes.
     */
    private fun hasNotifications() = NotificationManagerCompat.from(this).areNotificationsEnabled()

    /** Si Android aún puede preguntar, pregunta; si no (o estaban apagadas en Ajustes), abre sus ajustes. */
    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else openSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    /** Batería "sin restricciones": sin esto, HyperOS y otros pueden cortar la música con la pantalla bloqueada. */
    private fun hasBattery() = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        // Si ya lo negaste dos veces, Android no vuelve a preguntar: te llevamos a los ajustes de notificaciones
        if (!ok && Build.VERSION.SDK_INT >= 33 && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            openSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        if (!hasBattery()) askBattery()
    }

    @SuppressLint("BatteryLife")   // app personal fuera de Play Store: podemos pedirlo directamente
    private fun askBattery() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))   // algunos móviles no tienen la ventana directa
        }
    }

    private fun openSettings(intent: Intent) {
        try { startActivity(intent) } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    /** Al abrir: apunta en el registro cómo están los permisos y, si falta alguno, avisa (salvo "No volver a preguntar"). */
    private fun checkPermissions() {
        val notif = hasNotifications()
        val battery = hasBattery()
        KrzLog.d("[SISTEMA] Permisos: notificaciones ${if (notif) "sí" else "NO"}, batería sin restricciones ${if (battery) "sí" else "NO"}")
        val prefs = getSharedPreferences("krz", MODE_PRIVATE)
        if ((notif && battery) || prefs.getBoolean("noPermAsk", false)) return

        val missing = listOfNotNull(
            if (!notif) "• Notificaciones: para ver y controlar la música desde la barra y la pantalla de bloqueo." else null,
            if (!battery) "• Batería sin restricciones: para que la música no se corte con la pantalla bloqueada." else null,
        )
        AlertDialog.Builder(this)
            .setTitle("Para que KRZ Muzic funcione bien")
            .setMessage(missing.joinToString("\n\n") + "\n\nAndroid te preguntará cada uno: pulsa Permitir.")
            .setPositiveButton("Activar") { _, _ -> if (!notif) askNotifications() else askBattery() }
            .setNegativeButton("Ahora no", null)
            .setNeutralButton("No volver a preguntar") { _, _ -> prefs.edit().putBoolean("noPermAsk", true).apply() }
            .show()
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

        /** Copia de seguridad: abre "Guardar como" de Android con el nombre propuesto. */
        @JavascriptInterface fun saveBackup(json: String, name: String) {
            main.post { pendingBackup = json; saveBackup.launch(name) }
        }

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
