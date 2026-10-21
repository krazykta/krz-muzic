# KRZ muzic

Reproductor de música personal que usa YouTube como fuente, con interfaz oscura al estilo YouTube Music.
Es una **PWA** (Progressive Web App): una web que se puede instalar y abrir como si fuera una aplicación.

## Cómo arrancarla

1. Haz doble clic en **`iniciar.bat`**.
2. Se abre una ventana negra (el servidor) y, a los pocos segundos, el navegador en `http://localhost:8080`.
3. Deja la ventana negra abierta mientras uses la app. Para pararla, ciérrala.

> No abras `index.html` con doble clic: YouTube no reproduce vídeos en páginas abiertas como archivo (`file://`).

`iniciar.bat` necesita **Python** o **Node.js**. Para saber si tienes alguno, abre PowerShell y escribe:

```
python --version
node --version
```

Si los dos dan error, instala Python desde https://www.python.org/downloads/ (marca la casilla
"Add python.exe to PATH" durante la instalación).

## Instalarla como app

Con la app abierta en Chrome o Edge: botón **Instalar app** de la barra lateral, o el icono de instalar en la barra de direcciones.

## Qué hace

- **Buscador como el de YouTube**: escribes, salen sugerencias, eliges una (clic o Intro) y suena al momento el mejor resultado. Con el selector **Canciones / Playlists** buscas una cosa u otra.
- Página de resultados con canciones, vídeos, álbumes y playlists. Los álbumes y playlists se pueden abrir, reproducir y guardar en tu biblioteca.
- Tus propias playlists: crear, añadir canciones (menú ⋮ o botón ≡+ de lo que suena), ordenar, renombrar y borrar.
- Me gusta, canciones guardadas, escuchado recientemente, cola, aleatorio y repetir.
- Vista **Canción** (portada grande) o **Vídeo**.
- Recuerda lo que sonaba al cerrar. Copia de seguridad en un archivo `.json`.
- Atajos: `/` buscar, `espacio` o `k` pausa, `j` / `l` retrocede / avanza 10 s, `Mayús+N` siguiente, `Mayús+P` anterior, `m` silencio.

## Estructura

```
KRZ_muzic/
├── index.html            Estructura de la página (el esqueleto)
├── css/styles.css        Estilos: colores, tipografía, distribución
├── js/
│   ├── app.js            Interfaz: dibuja pantallas y responde a tus clics
│   ├── player.js         Motor: cola, siguiente, aleatorio, repetir
│   ├── catalog.js        Buscador: Piped e Invidious (servicios abiertos que leen YouTube)
│   ├── youtube.js        Reproductor oficial de YouTube y títulos
│   ├── ui.js             Avisos, menús y diálogos reutilizables
│   ├── store.js          Datos: guarda todo en el navegador (localStorage)
│   └── icons.js          Iconos SVG
├── sw.js                 Service worker: hace la app instalable y rápida
├── manifest.webmanifest  Nombre, icono y colores de la app instalada
├── icons/                Iconos de la app
└── iniciar.bat           Arranca un servidor local en Windows
```

## Límites conocidos

- Los datos viven en **este navegador**. Otro navegador u otro dispositivo empieza vacío: usa la copia de seguridad.
- En el móvil, la música se para al bloquear la pantalla o cambiar de app (lo impone YouTube en reproductores incrustados).
- Algunos vídeos no permiten reproducirse fuera de YouTube; la app los salta y avisa.
- El buscador usa servidores de voluntarios (Piped e Invidious). Si uno cae, la app prueba otro; si caen todos, la búsqueda falla un rato.
