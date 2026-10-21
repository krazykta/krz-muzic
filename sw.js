// sw.js — Service worker: un pequeño programa que el navegador ejecuta aparte de la página.
// Guarda una copia de los archivos de la app para que abra rápido y se pueda instalar.
// Estrategia "primero la red": si hay conexión siempre coge la versión nueva
// (así tus cambios se ven al recargar) y, si no la hay, usa la copia guardada.

const CACHE = 'krz-muzic-v6';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/store.js',
  'js/youtube.js',
  'js/player.js',
  'js/icons.js',
  'js/ui.js',
  'js/catalog.js',
  'js/recommend.js',
  'manifest.webmanifest',
  'icons/logo-mark.png',
  'icons/logo-full.png',
  'icons/favicon-64.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isOwn = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!isOwn && !isFont) return; // YouTube y miniaturas: que vayan directos

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
