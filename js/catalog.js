// catalog.js — Buscar en YouTube Music sin clave de API.
//
// Usamos dos servicios abiertos que leen YouTube por nosotros:
//  - Piped: busca como YouTube Music (canciones con su artista, álbumes, playlists, sugerencias).
//  - Invidious: de respaldo, y para leer el contenido completo de una playlist o álbum.
// Los dos tienen varios servidores ("instancias") mantenidos por voluntarios. Si uno falla,
// probamos el siguiente y recordamos el último que funcionó para ir más rápido la próxima vez.

import { cleanMeta } from './youtube.js';

const PIPED = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
];
const INVIDIOUS = [
  'https://invidious.f5.si',
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
];
const SERVERS_KEY = 'krz-muzic:servers';
let discovered = false;

// ---------- Elegir servidor ----------
function preferred() {
  try { return JSON.parse(localStorage.getItem(SERVERS_KEY)) || {}; } catch { return {}; }
}
function prefer(kind, base) {
  const p = preferred();
  if (p[kind] === base) return;
  p[kind] = base;
  try { localStorage.setItem(SERVERS_KEY, JSON.stringify(p)); } catch { /* sin espacio */ }
}
function order(kind, list) {
  const fav = preferred()[kind];
  return fav && list.includes(fav) ? [fav, ...list.filter((b) => b !== fav)] : list;
}

async function fetchJSON(url, ms = 7000) {
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

async function fromPiped(path, isValid) {
  let lastError = new Error('Sin servidores de Piped');
  for (const base of order('piped', PIPED)) {
    try {
      const data = await fetchJSON(base + path);
      if (isValid(data)) { prefer('piped', base); return data; }
      lastError = new Error('Respuesta inesperada');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function fromInvidious(path, isValid) {
  const tried = new Set();
  const attempt = async (list) => {
    for (const base of list) {
      if (tried.has(base)) continue;
      tried.add(base);
      try {
        const data = await fetchJSON(base + path, 9000);
        if (isValid(data)) { prefer('invidious', base); return data; }
      } catch { /* siguiente */ }
    }
    return null;
  };
  let data = await attempt(order('invidious', INVIDIOUS));
  if (data) return data;
  // Último recurso: pedir la lista pública de servidores sanos y probar algunos más
  if (!discovered) {
    discovered = true;
    try {
      const all = await fetchJSON('https://api.invidious.io/instances.json?sort_by=health', 6000);
      all.filter(([, i]) => i.cors && i.api && i.type === 'https').slice(0, 6)
        .forEach(([host]) => { const u = `https://${host}`; if (!INVIDIOUS.includes(u)) INVIDIOUS.push(u); });
    } catch { /* sin lista */ }
  }
  data = await attempt(INVIDIOUS);
  if (data) return data;
  throw new Error('Ningún servidor de búsqueda responde');
}

// ---------- Traducir respuestas a un formato común ----------
// Así el resto de la app no sabe ni le importa de qué servicio vienen los datos.
const enc = encodeURIComponent;
const isArr = Array.isArray;
const hasItems = (d) => d && isArr(d.items);
const videoFromUrl = (u) => (/[?&]v=([\w-]{11})/.exec(u || '') || [])[1] || null;
const listFromUrl = (u) => (/[?&]list=([\w-]+)/.exec(u || '') || [])[1] || null;
const noTopic = (s) => String(s || '').replace(/\s*-\s*Topic$/i, '').trim();
const cleanAlbum = (s) => String(s || '').replace(/^(Album|Álbum|EP|Single)\s*[-–]\s*/i, '').trim();
const DEAD = /^\[(deleted|private) video\]$/i;

function pipedStream(item, asSong) {
  const id = videoFromUrl(item.url);
  if (!id || item.isShort || item.type !== 'stream') return null;
  const meta = asSong ? { title: item.title, artist: noTopic(item.uploaderName) } : cleanMeta(item.title, item.uploaderName);
  return { type: asSong ? 'song' : 'video', id, ...meta, duration: item.duration > 0 ? item.duration : 0 };
}
function pipedList(item, type) {
  const listId = listFromUrl(item.url);
  if (!listId || item.type !== 'playlist') return null;
  return { type, listId, title: cleanAlbum(item.name), artist: noTopic(item.uploaderName), count: item.videos > 0 ? item.videos : null };
}
function invVideo(item) {
  if (item.type !== 'video' || !item.videoId) return null;
  return { type: 'video', id: item.videoId, ...cleanMeta(item.title, item.author), duration: item.lengthSeconds || 0 };
}
function invList(item) {
  if (item.type !== 'playlist' || !item.playlistId) return null;
  const firstId = (/vi\/([\w-]{11})\//.exec(item.playlistThumbnail || '') || [])[1] || null;
  return {
    type: item.playlistId.startsWith('OLAK') ? 'album' : 'playlist',
    listId: item.playlistId,
    title: cleanAlbum(item.title),
    artist: noTopic(item.author),
    count: item.videoCount || null,
    firstId,
  };
}

// ---------- Lo que usa la app ----------
/** Canciones (resultados de YouTube Music). Respaldo: vídeos de Invidious. */
export async function searchSongs(q) {
  try {
    const d = await fromPiped(`/search?q=${enc(q)}&filter=music_songs`, hasItems);
    return d.items.map((i) => pipedStream(i, true)).filter(Boolean);
  } catch {
    const d = await fromInvidious(`/api/v1/search?q=${enc(q)}&type=video`, isArr);
    return d.map(invVideo).filter(Boolean).map((v) => ({ ...v, type: 'song' }));
  }
}

export async function searchVideos(q) {
  try {
    const d = await fromPiped(`/search?q=${enc(q)}&filter=videos`, hasItems);
    return d.items.map((i) => pipedStream(i, false)).filter(Boolean);
  } catch {
    const d = await fromInvidious(`/api/v1/search?q=${enc(q)}&type=video`, isArr);
    return d.map(invVideo).filter(Boolean);
  }
}

export async function searchAlbums(q) {
  try {
    const d = await fromPiped(`/search?q=${enc(q)}&filter=music_albums`, hasItems);
    return d.items.map((i) => pipedList(i, 'album')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function searchPlaylists(q) {
  try {
    const d = await fromPiped(`/search?q=${enc(q)}&filter=music_playlists`, hasItems);
    return d.items.map((i) => pipedList(i, 'playlist')).filter(Boolean);
  } catch {
    const d = await fromInvidious(`/api/v1/search?q=${enc(q)}&type=playlist`, isArr);
    return d.map(invList).filter(Boolean);
  }
}

/** Sugerencias mientras escribes. Si fallan, no pasa nada: devolvemos []. */
export async function suggestions(q) {
  try {
    const d = await fromPiped(`/suggestions?query=${enc(q)}`, isArr);
    return d.slice(0, 6);
  } catch {
    try {
      const d = await fromInvidious(`/api/v1/search/suggestions?q=${enc(q)}`, (x) => x && isArr(x.suggestions));
      return d.suggestions.slice(0, 6);
    } catch {
      return [];
    }
  }
}

/** Contenido completo de un álbum o playlist de YouTube, con títulos y artistas. */
const listCache = new Map();
export function getList(listId) {
  if (listCache.has(listId)) return listCache.get(listId);
  const isAlbum = listId.startsWith('OLAK');
  const promise = fromInvidious(`/api/v1/playlists/${enc(listId)}`, (d) => d && isArr(d.videos)).then((d) => {
    const tracks = d.videos
      .filter((v) => v.videoId && !DEAD.test(v.title || ''))
      .map((v) => {
        const meta = isAlbum ? { title: v.title, artist: noTopic(v.author) } : cleanMeta(v.title, v.author);
        return { id: v.videoId, ...meta, duration: v.lengthSeconds || 0 };
      });
    return {
      listId,
      type: isAlbum ? 'album' : 'playlist',
      title: cleanAlbum(d.title),
      artist: noTopic(d.author) || (isAlbum && tracks[0] ? tracks[0].artist : ''),
      tracks,
    };
  });
  listCache.set(listId, promise);
  promise.catch(() => listCache.delete(listId));
  return promise;
}

/** "Mix" de YouTube a partir de una canción: la radio que YouTube genera con música parecida. */
const mixCache = new Map();
export function getMix(videoId) {
  if (mixCache.has(videoId)) return mixCache.get(videoId);
  const promise = fromPiped(`/playlists/RD${videoId}`, (d) => d && isArr(d.relatedStreams) && d.relatedStreams.length > 0)
    .then((d) => d.relatedStreams.map((s) => pipedStream(s, false)).filter(Boolean).map((t) => ({ ...t, type: 'song' })));
  mixCache.set(videoId, promise);
  promise.catch(() => mixCache.delete(videoId));
  return promise;
}
