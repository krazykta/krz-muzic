// youtube.js — Todo lo que habla con YouTube:
//  1) cargar la "IFrame Player API" (la librería oficial para controlar el reproductor de YouTube),
//  2) leer las canciones de una playlist pública,
//  3) obtener título y artista de un vídeo (con oEmbed, un formato estándar para pedir datos de un enlace).

const ID_RE = /^[\w-]{11}$/; // un id de vídeo de YouTube: 11 letras, números, "_" o "-"

// ---------- Carga de la API oficial del reproductor ----------
let apiPromise = null;

export function loadYouTubeAPI() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const timer = setTimeout(() => { apiPromise = null; reject(new Error('yt-api-timeout')); }, 15000);
    const previous = window.onYouTubeIframeAPIReady;
    // YouTube llama a esta función global cuando su librería está lista.
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (previous) previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => { clearTimeout(timer); apiPromise = null; reject(new Error('yt-api-failed')); };
    document.head.appendChild(script);
  });
  return apiPromise;
}

// ---------- Leer una playlist pública ----------
/**
 * Truco sin clave de API: creamos un reproductor invisible, le pedimos que cargue
 * la playlist y luego le preguntamos qué vídeos tiene (getPlaylist).
 * Límite conocido: YouTube solo devuelve las primeras ~200 canciones.
 */
export async function getPlaylistVideoIds(listId, helperEl) {
  const YT = await loadYouTubeAPI();
  const host = document.createElement('div');
  helperEl.appendChild(host);

  return new Promise((resolve, reject) => {
    let done = false;
    let poll = null;
    let helper = null;

    const finish = (err, ids) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      try { helper && helper.destroy(); } catch { /* ya estaba destruido */ }
      helperEl.innerHTML = '';
      if (err) reject(err); else resolve(ids);
    };

    const timeout = setTimeout(() => finish(new Error('playlist-timeout')), 20000);

    helper = new YT.Player(host, {
      width: 200,
      height: 200,
      playerVars: { listType: 'playlist', list: listId, autoplay: 0, controls: 0, origin: location.origin },
      events: {
        onReady: () => {
          poll = setInterval(() => {
            const ids = helper.getPlaylist && helper.getPlaylist();
            if (ids && ids.length) finish(null, ids.filter((id) => ID_RE.test(id)));
          }, 300);
        },
        onError: (e) => finish(new Error(`yt-${e.data}`)),
      },
    });
  });
}

// ---------- Título y artista ----------
/** Pide un JSON y se rinde a los `ms` milisegundos (si no, un servidor caído nos dejaría esperando). */
export async function fetchJSON(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Coletillas que estorban en el título: (Official Video), [Lyrics], (Video Oficial)…
const JUNK = /\s*[([](?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)|visualizer|lyric\s*video|video\s*lyrics?|video\s*oficial|audio\s*oficial|videoclip\s*oficial|lyrics?|letra|hd|4k)[)\]]/gi;

/** "Artista - Canción (Official Video)" + canal → { title: 'Canción', artist: 'Artista' } */
export function cleanMeta(title = '', author = '') {
  const rawTitle = String(title).trim();
  let t = rawTitle.replace(JUNK, '').trim();
  let artist = String(author).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    artist = m[1].trim();
    t = m[2].trim();
  }
  return { title: t || rawTitle, artist };
}

// Probamos primero el oEmbed oficial de YouTube y, si el navegador lo bloquea,
// un servicio público alternativo (noembed.com) que devuelve lo mismo.
async function oembed(targetUrl) {
  const sources = [
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(targetUrl)}`,
    `https://noembed.com/embed?url=${encodeURIComponent(targetUrl)}`,
  ];
  for (const src of sources) {
    try {
      const data = await fetchJSON(src);
      if (data && data.title) return data;
    } catch { /* probamos la siguiente fuente */ }
  }
  return null;
}

export async function fetchVideoMeta(videoId) {
  const data = await oembed(`https://www.youtube.com/watch?v=${videoId}`);
  return data ? cleanMeta(data.title, data.author_name) : null;
}

export async function fetchPlaylistTitle(listId) {
  const data = await oembed(`https://www.youtube.com/playlist?list=${listId}`);
  return data ? data.title : null;
}
