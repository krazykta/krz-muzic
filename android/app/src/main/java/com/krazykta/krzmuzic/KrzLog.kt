package com.krazykta.krzmuzic

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * KrzLog — el "cuaderno de bitácora" de la app.
 *
 * Apunta con fecha y hora todo lo que le pasa al reproductor (cortes, errores, cambios de red…)
 * en un archivo dentro de la app. Así, cuando algo falla, no tenemos que adivinar: leemos el registro.
 *
 * Se guarda en archivo (y no solo en memoria) para no perderlo si Android cierra la app.
 * Escribe desde un hilo propio para no frenar nunca la música ni la pantalla.
 */
object KrzLog {
    private const val MAX_BYTES = 200_000L          // ~2.000 líneas; al pasarse, borra la mitad más antigua
    private val writer = Executors.newSingleThreadExecutor()
    private val clock = SimpleDateFormat("dd/MM HH:mm:ss.SSS", Locale.US)
    @Volatile private var file: File? = null

    fun init(context: Context) {
        if (file == null) file = File(context.applicationContext.filesDir, "krz-log.txt")
    }

    /** Apunta una línea. Se puede llamar desde cualquier hilo. */
    fun d(message: String) {
        val now = System.currentTimeMillis()
        writer.execute {
            val f = file ?: return@execute
            try {
                if (f.length() > MAX_BYTES) {
                    val lines = f.readLines()
                    f.writeText(lines.takeLast(lines.size / 2).joinToString("\n", postfix = "\n"))
                }
                f.appendText("${clock.format(Date(now))}  $message\n")
            } catch (_: Exception) { /* sin espacio o similar: no es grave */ }
        }
    }

    fun read(): String = writer.submit<String> {
        file?.takeIf { it.exists() }?.readText() ?: ""
    }.get()

    fun clear() = writer.execute { file?.writeText("") }
}
