// app.js — La interfaz: dibuja las pantallas, responde a tus clics y conecta
// el almacén (store.js), el buscador (catalog.js) y el motor (player.js).

import { store } from './store.js';
import * as yt from './youtube.js';
import * as catalog from './catalog.js';
import * as reco from './recommend.js';
import { createPlayer } from './player.js';
import { icon } from './icons.js';
import {
  $, $$, esc, thumb, plural, norm, setP, fmt, clock, debounce,
  toast, openMenu, closeMenu, dialog, closeDialog, confirmDialog, info,
} from './ui.js';

const isMobile = () => matchMedia('(max-width: 820px)').matches;

// ================================================================
// 1. Estado de la interfaz (lo que no hace falta guardar)
// ================================================================
let player = null;
let route = { name: 'home', arg: '' };
let listCtx = { ids: [], label: '' }; // la lista visible (para saber qué reproducir al pulsar)
let page = null;                     // página de lista actual (para el filtro)
let filter = '';
let searchTab = 'all';
let dragging = false;
let duration = 0;
let lastAmbient = null;
let ambFlip = false;
let installEvt = null;
let viewToken = 0;                   // evita pintar resultados viejos si cambias de pantalla
let lastViewKey = '';                // última pantalla pintada (para conservar el scroll de los carruseles)
const resolving = new Set();
const durationSaved = new Set();
const metaCache = new Map();         // canciones vistas en búsquedas (sin guardar)
const searchCache = new Map();       // "tipo:consulta" → Promesa con resultados
let recoData = reco.getCached();     // recomendaciones (las últimas calculadas)
let recoLoading = false;
let recoError = false;
let playCounted = false;             // ¿ya contamos la escucha de la canción actual?
let popularData = reco.getCachedPopular(); // éxitos del momento (se guardan 12 h)
let popularLoading = false;
let sliderList = [];                 // canciones del carrusel (para reproducirlas)
let sliderTouched = 0;               // última vez que tocaste el carrusel (pausa el avance automático)

const EXPLORE = [
  'Éxitos del momento', 'Rock', 'Metal', 'Dubstep', 'Heavy metal', 'Metalcore', 'Hard rock', 'Punk rock',
  'Rock clásico', 'Rock en español', 'Indie', 'Pop en español', 'Reguetón', 'Trap', 'Hip hop', 'Rap español',
  'Electrónica', 'Techno', 'House', 'Drum and bass', 'Hardstyle', 'Synthwave', 'Lo-fi para concentrarse',
  'Flamenco', 'Salsa', 'Bachata', 'Reggae', 'Funk', 'Blues', 'Jazz para la noche', 'Clásica', 'Años 80', 'Años 90',
];

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return 'Buenas noches';
  if (h < 13) return 'Buenos días';
  if (h < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

// ---------- Datos de una canción, venga de donde venga ----------
function trackInfo(id) {
  return store.get().tracks[id] || metaCache.get(id) || { id, title: '', artist: '', duration: 0 };
}
function remember(tracks) {
  tracks.forEach((t) => { if (t && t.id) metaCache.set(t.id, { ...metaCache.get(t.id), ...t }); });
}
/** Guarda en el almacén canciones que solo estaban en memoria (save=true → también en Canciones). */
function ensureStored(ids, { save = false } = {}) {
  store.upsertTracks(ids.map((id) => {
    const { inLibrary, ...rest } = trackInfo(id);
    return { ...rest, id, inLibrary: save };
  }), { notify: save });
}
function cachedSearch(kind, q) {
  const key = `${kind}:${norm(q)}`;
  if (!searchCache.has(key)) {
    const fn = { songs: catalog.searchSongs, videos: catalog.searchVideos, albums: catalog.searchAlbums, playlists: catalog.searchPlaylists }[kind];
    const p = fn(q).then((res) => { remember(res.filter((r) => r.id)); return res; });
    searchCache.set(key, p);
    p.catch(() => searchCache.delete(key));
  }
  return searchCache.get(key);
}

// ================================================================
// 2. Rutas: la parte de la URL después de # decide la pantalla
//    #/home  #/search/texto  #/foryou  #/songs  #/likes  #/playlists  #/playlist/ID  #/remote/IDYOUTUBE
// ================================================================
const ROUTES = ['home', 'search', 'foryou', 'songs', 'likes', 'playlists', 'playlist', 'remote', 'diag'];
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  let arg = '';
  try { arg = rest.length ? decodeURIComponent(rest.join('/')) : ''; } catch { arg = rest.join('/'); }
  return { name: ROUTES.includes(name) ? name : 'home', arg };
}
const go = (path) => { location.hash = `#/${path}`; };
const goSearch = (q) => { searchTab = 'all'; go(`search/${encodeURIComponent(q.trim())}`); };

window.addEventListener('hashchange', () => {
  route = parseHash();
  filter = '';
  closeMenu();
  closeSearchPop();
  if (route.name === 'search') $('#search-input').value = route.arg;
  renderView();
  renderNav();
  renderSidebar();
  $('#main').scrollTop = 0;
  if (isMobile()) setNp(false);
});

// ================================================================
// 3. Piezas reutilizables de HTML
// ================================================================
const img = (id, cls = '') => `<img class="${cls}" src="${thumb(id)}" alt="" loading="lazy">`;
const EQ = '<span class="eq"><i></i><i></i><i></i></span>';

function subtitle(t, id) {
  if (t.title) return t.artist || '';
  return resolving.has(id) ? 'Buscando título…' : 'Se completará al reproducirla';
}

function cover(p, extra = '') {
  const ids = p.trackIds.slice(0, 4);
  if (ids.length >= 4) return `<span class="card-art mosaic ${extra}">${ids.map((id) => img(id)).join('')}</span>`;
  if (ids.length) return `<span class="card-art ${extra}">${img(ids[0])}</span>`;
  return `<span class="card-art cover-blank ${extra}"><span>${esc((p.name || '?').charAt(0).toUpperCase())}</span></span>`;
}
const likesCover = (extra = '') => `<span class="card-art cover-likes ${extra}">${icon('heart-on')}</span>`;

function rows(pairs) {
  const s = store.get();
  return pairs.map(({ id, pos }, i) => {
    const t = trackInfo(id);
    const liked = s.likes.includes(id);
    return `
      <li class="row${t.title ? '' : ' is-pending'}" data-id="${id}">
        <button class="row-main" data-action="play-from" data-index="${i}">
          <span class="thumb-wrap">${img(id)}<span class="row-play">${icon('play')}</span>${EQ}</span>
          <span class="row-text">
            <span class="row-title">${esc(t.title || 'Título pendiente')}</span>
            <span class="row-artist">${esc(subtitle(t, id))}</span>
          </span>
        </button>
        <span class="row-time">${fmt(t.duration)}</span>
        <button class="icon-btn${liked ? ' on' : ''}" data-action="like" data-id="${id}" aria-pressed="${liked}" aria-label="${liked ? 'Quitar de Me gusta' : 'Añadir a Me gusta'}">${icon(liked ? 'heart-on' : 'heart')}</button>
        <button class="icon-btn" data-action="track-menu" data-id="${id}" data-pos="${pos ?? i}" aria-label="Más opciones">${icon('more')}</button>
      </li>`;
  }).join('');
}
const toPairs = (ids) => ids.map((id, pos) => ({ id, pos }));

function trackCard(id, i, action = 'play-from', list = '') {
  const t = trackInfo(id);
  const attrs = `data-action="${action}" data-index="${i}" data-list="${list}"`;
  return `
    <div class="card" data-id="${id}">
      <span class="card-art">${img(id)}${EQ}<button class="card-play" ${attrs} aria-label="Reproducir ${esc(t.title)}">${icon('play')}</button></span>
      <button class="card-title stretched" ${attrs}>${esc(t.title || 'Título pendiente')}</button>
      <span class="card-sub">${esc(t.artist || '')}</span>
    </div>`;
}

// Mete el botón de play dentro de la portada (justo antes de cerrar su <span>)
const withPlay = (artHtml, btn) => artHtml.replace(/<\/span>\s*$/, `${btn}</span>`);

function playlistCard(p) {
  const btn = p.trackIds.length ? `<button class="card-play" data-action="play-playlist" data-id="${p.id}" aria-label="Reproducir ${esc(p.name)}">${icon('play')}</button>` : '';
  return `
    <div class="card">
      ${withPlay(cover(p), btn)}
      <a class="card-title stretched" href="#/playlist/${p.id}">${esc(p.name)}</a>
      <span class="card-sub">${plural(p.trackIds.length, 'canción', 'canciones')}</span>
    </div>`;
}

function remoteCard(item) {
  const btn = `<button class="card-play" data-action="play-remote" data-list="${esc(item.listId)}" aria-label="Reproducir ${esc(item.title)}">${icon('play')}</button>`;
  const art = item.firstId
    ? `<span class="card-art">${img(item.firstId)}${btn}</span>`
    : `<span class="card-art cover-blank" data-cover-list="${esc(item.listId)}"><span class="blank-letter">${esc((item.title || '?').charAt(0).toUpperCase())}</span>${btn}</span>`;
  const kind = item.type === 'album' ? 'Álbum' : 'Playlist';
  return `
    <div class="card">
      ${art}
      <a class="card-title stretched" href="#/remote/${encodeURIComponent(item.listId)}">${esc(item.title)}</a>
      <span class="card-sub">${esc([kind, item.artist].filter(Boolean).join(' de '))}</span>
    </div>`;
}

function playlistGrid() {
  const { playlists } = store.get();
  return `
    <div class="grid">
      ${playlists.map(playlistCard).join('')}
      <div class="card card-new">
        <span class="card-art new-art">${icon('add', 36)}</span>
        <button class="card-title stretched" data-action="new-playlist">Nueva playlist</button>
      </div>
    </div>`;
}

/** Portadas de álbumes/playlists: pedimos su primera canción poco a poco (y así abrirlos luego es instantáneo). */
function hydrateCovers() {
  const els = $$('[data-cover-list]').slice(0, 12);
  let i = 0;
  const next = () => {
    const el = els[i++];
    if (!el) return;
    catalog.getList(el.dataset.coverList)
      .then((l) => {
        remember(l.tracks);
        if (l.tracks[0] && el.isConnected) {
          el.classList.remove('cover-blank');
          el.removeAttribute('data-cover-list');
          el.querySelector('.blank-letter')?.remove();
          el.insertAdjacentHTML('afterbegin', img(l.tracks[0].id));
        }
      })
      .catch(() => {})
      .finally(next);
  };
  next(); next(); next(); // tres a la vez
}

// ================================================================
// 4. Dibujar (render)
// ================================================================
function renderAll() {
  renderSidebar();
  renderNav();
  renderView();
  renderQueue();
  refreshNowPlaying();
}

function renderNav() {
  const map = { playlist: 'playlists', remote: 'search' };
  const active = map[route.name] || route.name;
  $$('[data-nav]').forEach((el) => {
    const also = (el.dataset.navAlso || '').split(' ');
    el.classList.toggle('active', el.dataset.nav === active || also.includes(route.name));
  });
}

function renderSidebar() {
  const { playlists } = store.get();
  $('#side-playlists').innerHTML = playlists.length
    ? playlists.map((p) => `
        <li><a class="side-pl ${route.name === 'playlist' && route.arg === p.id ? 'active' : ''}" href="#/playlist/${p.id}">
          ${cover(p, 'side-art')}
          <span class="side-pl-text"><span class="ellipsis">${esc(p.name)}</span><small>${p.source === 'youtube' ? 'De YouTube' : 'Playlist'}, ${p.trackIds.length}</small></span>
        </a></li>`).join('')
    : '<li class="side-empty">Crea una playlist o guarda una desde el buscador.</li>';
}

function renderView() {
  const hadFocus = document.activeElement && document.activeElement.id === 'filter';
  const caret = hadFocus ? document.activeElement.selectionStart : 0;
  const token = ++viewToken;
  // Al redibujar la misma pantalla (cambio de canción, Me gusta…) los carruseles no vuelven al principio
  const key = `${route.name}/${route.arg || ''}`;
  const changed = key !== lastViewKey;
  const scrolls = changed ? [] : $$('#view .slider, #view .shelf').map((el) => el.scrollLeft);
  lastViewKey = key;

  const views = { diag: viewDiag, foryou: viewForYou, songs: viewSongs, likes: viewLikes, playlists: viewPlaylists, playlist: viewPlaylist, search: viewSearch, remote: viewRemote };
  const view = $('#view');
  view.innerHTML = (views[route.name] || viewHome)(token);
  // Pantalla nueva: entra con un fundido suave (al redibujar la misma, no, que parpadearía)
  if (changed) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  $$('#view .slider, #view .shelf').forEach((el, i) => { if (scrolls[i]) el.scrollTo({ left: scrolls[i], behavior: 'instant' }); });

  if (hadFocus) {
    const f = $('#filter');
    if (f) { f.focus(); f.setSelectionRange(caret, caret); }
  }
  markCurrent();
  hydrateCovers();
}

const setList = (ids, label) => { listCtx = { ids, label }; };
const stillHere = (token) => token === viewToken;

function applyFilter(ids) {
  const pairs = toPairs(ids);
  const q = norm(filter.trim());
  if (!q) return pairs;
  return pairs.filter(({ id }) => { const t = trackInfo(id); return norm(`${t.title} ${t.artist}`).includes(q); });
}

/** Página con lista de canciones: cabecera + botones + filas */
function listPage(opts) {
  page = opts;
  const pairs = applyFilter(opts.ids);
  setList(pairs.map((p) => p.id), opts.label);
  const has = opts.ids.length > 0;
  return `
    ${opts.header}
    <div class="toolbar">
      <button class="play-btn large" data-action="play-all" ${has ? '' : 'disabled'} aria-label="Reproducir">${icon('play')}</button>
      <button class="icon-btn big" data-action="shuffle-all" ${has ? '' : 'disabled'} aria-label="Reproducir en aleatorio" title="Aleatorio">${icon('shuffle')}</button>
      ${opts.extra || ''}
      ${opts.ids.length > 6 ? `<label class="filter">${icon('search')}<input id="filter" type="search" placeholder="Filtrar" value="${esc(filter)}" aria-label="Filtrar canciones"></label>` : ''}
    </div>
    ${has
      ? `<ol class="tracks" id="tracks">${pairs.length ? rows(pairs) : noMatch()}</ol>`
      : `<div class="empty"><p>${opts.empty}</p></div>`}`;
}
const noMatch = () => `<li class="queue-empty">Nada coincide con «${esc(filter)}».</li>`;

function refilter() {
  if (!page || !$('#tracks')) return;
  const pairs = applyFilter(page.ids);
  setList(pairs.map((p) => p.id), page.label);
  $('#tracks').innerHTML = pairs.length ? rows(pairs) : noMatch();
  markCurrent();
}

function header({ art, kind, title, meta }) {
  return `
    <header class="hero">
      ${art}
      <div class="hero-info">
        <p class="hero-kind">${esc(kind)}</p>
        <h1 class="hero-title">${esc(title)}</h1>
        ${meta ? `<p class="meta">${meta}</p>` : ''}
      </div>
    </header>`;
}

// ---------- Pantallas ----------
function viewHome() {
  page = null;
  const s = store.get();
  const recent = s.recent.filter((id) => s.tracks[id]).slice(0, 12);
  setList(recent, 'Escuchado hace poco');
  const tiles = [];
  if (s.likes.length) {
    tiles.push(`<div class="tile">${likesCover('tile-art')}<a class="tile-name stretched" href="#/likes">Me gusta</a><button class="tile-play" data-action="play-likes" aria-label="Reproducir Me gusta">${icon('play')}</button></div>`);
  }
  s.playlists.slice(0, 7).forEach((p) => {
    tiles.push(`<div class="tile">${cover(p, 'tile-art')}<a class="tile-name stretched" href="#/playlist/${p.id}">${esc(p.name)}</a>${p.trackIds.length ? `<button class="tile-play" data-action="play-playlist" data-id="${p.id}" aria-label="Reproducir ${esc(p.name)}">${icon('play')}</button>` : ''}</div>`);
  });
  return `
    <header class="view-head"><h1 class="title-xl">${greeting()}</h1></header>
    ${installBanner()}
    ${sliderSection()}
    ${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}
    ${recoHomeSection()}
    ${recent.length ? `
      <section class="block">
        <h2>Escuchado hace poco</h2>
        <div class="shelf">${recent.map(trackCard).join('')}</div>
      </section>` : ''}
    <section class="block">
      <h2>Tus playlists</h2>
      ${playlistGrid()}
    </section>`;
}

function viewPlaylists() {
  page = null;
  setList([], '');
  const s = store.get();
  return `
    <header class="view-head"><h1 class="title-xl">Biblioteca</h1></header>
    <div class="tiles">
      <div class="tile">${likesCover('tile-art')}<a class="tile-name stretched" href="#/likes">Me gusta</a></div>
      <div class="tile"><span class="card-art cover-songs tile-art">${icon('music')}</span><a class="tile-name stretched" href="#/songs">Canciones guardadas</a></div>
    </div>
    <section class="block"><h2>Tus playlists</h2>${playlistGrid()}</section>
    ${s.playlists.length ? '' : '<p class="muted-note">Las playlists que guardes desde el buscador también aparecerán aquí.</p>'}
    ${window.KRZNative ? '<p class="diag-link"><a class="btn btn-ghost" href="#/diag">Diagnóstico de reproducción</a></p>' : ''}`;
}

// ---------- Diagnóstico (solo en la app Android) ----------
// Lee el registro que escribe Android (KrzLog.kt) y cuenta lo que ha pasado por etiquetas.
const DIAG_COUNTS = [
  { label: 'Cortes por falta de datos', test: (l) => l.includes('[CORTE] Se ha quedado') },
  { label: 'Trozos que fallaron al descargar', test: (l) => l.includes('[RED] Falló la descarga') },
  { label: 'Pérdidas de conexión', test: (l) => l.includes('[RED] Conexión perdida') },
  { label: 'Pausas por otra app', test: (l) => l.includes('[PAUSA]') && l.includes('otra app') },
  { label: 'Errores graves', test: (l) => l.includes('[ERROR]') },
];

function readLog() {
  try { return window.KRZNative.getLog() || ''; } catch { return ''; }
}

function viewDiag() {
  page = null;
  setList([], '');
  if (!window.KRZNative || !window.KRZNative.getLog) {
    return `<header class="view-head"><h1 class="title-xl">Diagnóstico</h1></header>
      <p class="muted-note">El diagnóstico solo está disponible dentro de la app Android (versión nueva).</p>`;
  }
  const lines = readLog().trim().split('\n').filter(Boolean);
  const stats = DIAG_COUNTS.map((c) => `<div class="diag-stat"><b>${lines.filter(c.test).length}</b><span>${c.label}</span></div>`).join('');
  const tagOf = (l) => (l.match(/\[(CORTE|RED|PAUSA|ERROR|CARGA|WEB|BOTÓN|SISTEMA)\]/) || [])[1] || '';
  const rows = lines.slice(-400).reverse()
    .map((l) => `<div class="diag-line t-${tagOf(l).toLowerCase()}">${esc(l)}</div>`).join('');
  return `
    <header class="view-head"><h1 class="title-xl">Diagnóstico</h1></header>
    <p class="muted-note">Escucha música como siempre. Cuando se corte, vuelve aquí y pulsa «Enviar registro»: verás qué pasó y a qué hora.</p>
    <div class="diag-stats">${stats}</div>
    <div class="diag-actions">
      <button class="btn btn-primary" data-action="diag-share">Enviar registro</button>
      <button class="btn btn-ghost" data-action="diag-refresh">Actualizar</button>
      <button class="btn btn-ghost" data-action="diag-clear">Borrar</button>
    </div>
    <div class="diag-log">${rows || '<div class="diag-line">Todavía no hay nada apuntado.</div>'}</div>`;
}

function shareLog() {
  const N = window.KRZNative;
  const head = `KRZ Muzic — ${N.deviceInfo ? N.deviceInfo() : ''}\n${navigator.userAgent}\n\n`;
  // Las 600 últimas líneas son suficientes (y caben en un mensaje)
  N.share(head + readLog().trim().split('\n').slice(-600).join('\n'));
}

function viewSongs() {
  const all = Object.values(store.get().tracks).filter((t) => t.inLibrary).sort((a, b) => b.addedAt - a.addedAt).map((t) => t.id);
  return listPage({
    header: header({ art: `<span class="card-art cover-songs hero-art">${icon('music')}</span>`, kind: 'Biblioteca', title: 'Canciones', meta: plural(all.length, 'canción guardada', 'canciones guardadas') }),
    ids: all,
    label: 'Canciones',
    empty: 'Aquí aparecen las canciones que guardas: con el corazón, con «Guardar en Canciones» en el menú ⋮ o añadiéndolas a una playlist.',
  });
}

function viewLikes() {
  const s = store.get();
  const ids = s.likes.filter((id) => s.tracks[id]);
  return listPage({
    header: header({ art: likesCover('hero-art'), kind: 'Playlist', title: 'Me gusta', meta: plural(ids.length, 'canción', 'canciones') }),
    ids,
    label: 'Me gusta',
    empty: 'Pulsa el corazón de cualquier canción y la tendrás aquí.',
  });
}

function viewPlaylist() {
  const p = store.getPlaylist(route.arg);
  if (!p) {
    page = null;
    setList([], '');
    return '<div class="empty"><h2>Esta playlist ya no existe</h2><p><a href="#/home">Volver al inicio</a></p></div>';
  }
  const total = p.trackIds.reduce((sum, id) => sum + (trackInfo(id).duration || 0), 0);
  return listPage({
    header: header({
      art: cover(p, 'hero-art'),
      kind: p.source === 'youtube' ? 'Playlist guardada de YouTube' : 'Playlist',
      title: p.name,
      meta: [plural(p.trackIds.length, 'canción', 'canciones'), total > 60 ? `${Math.round(total / 60)} min` : ''].filter(Boolean).join(', '),
    }),
    ids: p.trackIds,
    label: p.name,
    empty: 'Esta playlist está vacía. Busca una canción arriba y usa su menú ⋮ para añadirla aquí.',
    extra: `<button class="icon-btn big" data-action="playlist-menu" aria-label="Opciones de la playlist">${icon('more')}</button>`,
  });
}

// ---------- Para ti (recomendaciones) ----------
const joinNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0] || '');

function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${plural(h, 'hora', 'horas')}` : `hace ${plural(Math.round(h / 24), 'día', 'días')}`;
}

function rememberReco() {
  if (!recoData) return;
  remember(recoData.picks || []);
  remember(recoData.artistPicks || []);
  (recoData.mixes || []).forEach((m) => remember(m.tracks));
}

function mixCard(m, i) {
  return `
    <div class="card mix-card">
      <span class="card-art mix-art m${i % 3}">${img(m.seedId)}<span class="mix-name">${esc(m.artist)}</span>
        <button class="card-play" data-action="play-mix" data-seed="${m.seedId}" aria-label="Reproducir el mix de ${esc(m.artist)}">${icon('play')}</button></span>
      <button class="card-title stretched" data-action="play-mix" data-seed="${m.seedId}">Mix de ${esc(m.artist)}</button>
      <span class="card-sub">${m.others.length ? `Con ${esc(joinNames(m.others))}` : 'Música parecida'}</span>
    </div>`;
}

/** Calcula las recomendaciones en segundo plano si hace falta y repinta solo esa parte */
function ensureReco({ force = false } = {}) {
  if (recoLoading) return;
  if (!reco.tasteProfile().seeds.length) return;
  if (!force && recoData && !reco.isStale()) return;
  if (!force && recoError) return; // no reintentar solo en bucle: espera al botón Reintentar
  recoLoading = true;
  recoError = false;
  reco.buildRecommendations()
    .then((d) => { if (d) { recoData = d; rememberReco(); } })
    .catch((err) => { console.warn('[reco]', err); recoError = true; })
    .finally(() => {
      recoLoading = false;
      if (route.name === 'foryou') renderView();
      else if (route.name === 'home' && $('#reco-home')) { $('#reco-home').innerHTML = recoHomeInner(); refreshSlider(); markCurrent(); }
    });
}

function recoHomeSection() {
  if (!reco.tasteProfile().seeds.length) return '';
  setTimeout(() => ensureReco(), 0);
  return `<section class="block" id="reco-home">${recoHomeInner()}</section>`;
}

function recoHomeInner() {
  const head = '<div class="block-head"><h2>Para ti</h2><a class="see-all" href="#/foryou">Ver todo</a></div>';
  if (!recoData) {
    return head + (recoError
      ? '<p class="muted-note">No se han podido preparar las recomendaciones ahora mismo. <button class="link-btn" data-action="refresh-reco">Reintentar</button></p>'
      : '<div class="loading"><span class="spinner"></span>Preparando recomendaciones con lo que escuchas…</div>');
  }
  return `${head}
    ${recoData.mixes.length ? `<div class="shelf">${recoData.mixes.map(mixCard).join('')}</div>` : ''}
    ${recoData.picks.length ? `
      <h3 class="sub-head">Canciones que te pueden gustar</h3>
      <div class="shelf">${recoData.picks.slice(0, 12).map((t, i) => trackCard(t.id, i, 'play-reco', 'picks')).join('')}</div>` : ''}`;
}

function viewForYou() {
  page = null;
  const prof = reco.tasteProfile();
  const head = `
    <header class="view-head">
      <h1 class="title-xl">Para ti</h1>
      ${prof.artists.length ? `<p class="meta">Basado en lo que escuchas: ${esc(joinNames(prof.artists.slice(0, 3)))}</p>` : ''}
    </header>`;
  if (!prof.seeds.length) {
    setList([], '');
    return `${head}
      <div class="empty"><h2>Aún no conozco tus gustos</h2>
      <p>Escucha algunas canciones (cuentan a partir de 30 segundos) o dale al corazón a las que te gusten. En cuanto tenga algo de historial, aquí aparecerán mixes y canciones nuevas hechos a tu medida.</p></div>`;
  }
  setTimeout(() => ensureReco(), 0);
  if (!recoData) {
    setList([], '');
    return head + (recoError
      ? `<div class="empty"><h2>No se han podido preparar</h2><p>Los servidores no responden ahora mismo.</p><p><button class="btn btn-ghost" data-action="refresh-reco">Reintentar</button></p></div>`
      : '<div class="loading page-loading"><span class="spinner"></span>Preparando recomendaciones con lo que escuchas…</div>');
  }
  const ids = recoData.picks.map((t) => t.id);
  setList(ids, 'Recomendado para ti');
  return `${head}
    ${recoData.mixes.length ? `<section class="block"><h2>Tus mixes</h2><div class="grid">${recoData.mixes.map(mixCard).join('')}</div></section>` : ''}
    ${ids.length ? `
      <section class="block">
        <h2>Canciones que te pueden gustar</h2>
        <div class="toolbar">
          <button class="play-btn large" data-action="play-all" aria-label="Reproducir">${icon('play')}</button>
          <button class="icon-btn big" data-action="shuffle-all" aria-label="Reproducir en aleatorio" title="Aleatorio">${icon('shuffle')}</button>
          <button class="btn btn-ghost" data-action="refresh-reco">${icon('refresh')}Actualizar</button>
        </div>
        <ol class="tracks" id="tracks">${rows(toPairs(ids))}</ol>
      </section>` : ''}
    ${recoData.artistPicks.length ? `
      <section class="block"><h2>Más de ${esc(recoData.topArtist)}</h2>
      <div class="shelf">${recoData.artistPicks.map((t, i) => trackCard(t.id, i, 'play-reco', 'artist')).join('')}</div></section>` : ''}
    <p class="muted-note">Actualizado ${timeAgo(recoData.at)}${recoLoading ? '. Actualizando…' : '.'}</p>`;
}

// ---------- Aviso de instalación ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  || navigator.userAgent.includes('KRZMuzicApp'); // dentro de la app Android
function installBanner() {
  if (isStandalone() || !installEvt) return '';
  return `
    <div class="install-banner">
      <img src="icons/icon-192.png" alt="">
      <span><b>Instala KRZ Muzic</b><br>Ábrela como una app, a pantalla completa.</span>
      <button class="btn btn-primary" data-action="install">Instalar</button>
    </div>`;
}

// ---------- Carrusel "Lo que suena" ----------
function ensurePopular() {
  if (popularLoading || reco.popularIsFresh(popularData)) return;
  popularLoading = true;
  reco.loadPopular()
    .then((d) => { popularData = d; remember(d.tracks); })
    .catch((err) => console.warn('[populares]', err))
    .finally(() => { popularLoading = false; refreshSlider(); });
}

function refreshSlider() {
  const el = $('#slider-home');
  if (route.name === 'home' && el) { el.innerHTML = sliderInner(); markCurrent(); }
}

function sliderSection() {
  setTimeout(() => ensurePopular(), 0);
  return `<section class="block slider-block" id="slider-home">${sliderInner()}</section>`;
}

function sliderInner() {
  const { tracks, weight } = reco.composeSlider(popularData, recoData);
  sliderList = tracks;
  const pct = Math.round(weight * 100);
  const head = `
    <div class="block-head">
      <h2>Lo que suena</h2>
      <div class="slider-nav">
        <button class="icon-btn" data-action="slide" data-dir="-1" aria-label="Anterior">${icon('chevron-left')}</button>
        <button class="icon-btn" data-action="slide" data-dir="1" aria-label="Siguiente">${icon('chevron-right')}</button>
      </div>
    </div>
    <p class="slider-note">${pct
      ? `Éxitos del momento mezclados con lo que te gusta: ${pct} % hecho para ti`
      : 'Éxitos del momento. Cuanto más escuches, más se parecerá a tus gustos.'}</p>`;
  if (!tracks.length) {
    return head + (popularLoading || !popularData
      ? `<div class="slider" role="status" aria-label="Cargando lo que suena ahora…">${'<div class="slide sk"></div>'.repeat(3)}</div>`
      : '<p class="muted-note">No se han podido cargar los éxitos ahora mismo.</p>');
  }
  return `${head}
    <div class="slider" id="slider">
      ${tracks.map((t, i) => `
        <div class="slide" data-id="${t.id}">
          ${img(t.id, 'slide-img')}
          <span class="slide-shade"></span>
          <span class="slide-tag ${t.personal ? 'is-personal' : ''}">${t.personal ? 'Para ti' : 'Popular'}</span>
          <span class="slide-text">
            <span class="slide-title">${esc(t.title)}</span>
            <span class="slide-artist">${esc(t.artist || '')}</span>
          </span>
          ${EQ}
          <button class="play-btn large slide-play" data-action="play-slide" data-index="${i}" aria-label="Reproducir ${esc(t.title)}">${icon('play')}</button>
          <button class="stretched slide-hit" data-action="play-slide" data-index="${i}" aria-label="Reproducir ${esc(t.title)}"></button>
        </div>`).join('')}
    </div>
    <div class="dots" id="slider-dots">${tracks.map((t, i) => `<button class="dot${i ? '' : ' on'}" data-action="slide-to" data-index="${i}" aria-label="Ver la ${i + 1}.ª: ${esc(t.title)}"></button>`).join('')}</div>`;
}

function moveSlider(dir) {
  const el = $('#slider');
  if (!el) return;
  const step = slideStep(el);
  const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
  if (dir > 0 && atEnd) el.scrollTo({ left: 0, behavior: 'smooth' });
  else el.scrollBy({ left: dir * step, behavior: 'smooth' });
}

// Avance automático cada 6 s (se pausa si lo tocas, si pasas el ratón o si prefieres menos movimiento)
setInterval(() => {
  const el = $('#slider');
  if (!el || route.name !== 'home' || document.visibilityState !== 'visible') return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (el.matches(':hover') || Date.now() - sliderTouched < 15000) return;
  moveSlider(1);
}, 6000);

/** Carrusel: cuánto se mueve para pasar de una portada a la siguiente (ancho + hueco). */
function slideStep(el) {
  const slide = el.querySelector('.slide');
  return slide ? slide.offsetWidth + 16 : el.clientWidth * 0.8;
}

/** Puntos bajo el carrusel: se enciende el de la portada que estás viendo. */
function updateDots() {
  const el = $('#slider');
  const dots = $$('#slider-dots .dot');
  if (!el || !dots.length) return;
  const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
  const i = atEnd ? dots.length - 1 : Math.round(el.scrollLeft / slideStep(el));
  dots.forEach((d, k) => d.classList.toggle('on', k === i));
}

// ---------- Buscar ----------
/** "Esqueleto": la forma gris de los resultados mientras llegan (se nota más rápido que un círculo girando). */
const skeleton = (label) => `
  <div class="skeleton" role="status" aria-label="${label}">
    ${'<div class="sk-row"><span class="sk-art"></span><span class="sk-lines"><i></i><i></i></span></div>'.repeat(6)}
  </div>`;

function viewSearch(token) {
  page = null;
  const q = route.arg.trim();
  if (!q) {
    setList([], '');
    const recent = store.get().searches;
    if (!isMobile()) setTimeout(() => $('#search-input').focus(), 0);
    return `
      <header class="view-head"><h1 class="title-xl">Buscar</h1></header>
      ${recent.length ? `
        <section class="block">
          <h2>Búsquedas recientes</h2>
          <div class="chips">${recent.map((r) => `<span class="chip-wrap"><button class="chip" data-action="go-search" data-q="${esc(r)}">${esc(r)}</button><button class="chip-x" data-action="forget-search" data-q="${esc(r)}" aria-label="Olvidar ${esc(r)}">${icon('close', 16)}</button></span>`).join('')}</div>
        </section>` : ''}
      <section class="block">
        <h2>Explorar</h2>
        <div class="explore">${EXPLORE.map((e, i) => `<button class="explore-card c${i % 5}" data-action="go-search" data-q="${esc(e)}">${esc(e)}</button>`).join('')}</div>
      </section>`;
  }

  store.pushSearch(q);
  setList([], '');
  const tabs = [['all', 'Todo'], ['songs', 'Canciones'], ['videos', 'Vídeos'], ['albums', 'Álbumes'], ['playlists', 'Playlists']];
  fillSearch(q, searchTab, token);
  return `
    <div class="chips tabs" role="tablist">${tabs.map(([k, label]) => `<button class="chip${k === searchTab ? ' on' : ''}" role="tab" aria-selected="${k === searchTab}" data-action="search-tab" data-tab="${k}">${label}</button>`).join('')}</div>
    <div id="search-results">${skeleton(`Buscando «${esc(q)}»…`)}</div>`;
}

async function fillSearch(q, tab, token) {
  const out = (html) => { if (stillHere(token)) { $('#search-results').innerHTML = html; markCurrent(); hydrateCovers(); } };
  const label = `Búsqueda «${q}»`;
  const failMsg = `
    <div class="empty"><h2>No se ha podido buscar</h2>
    <p>Los servidores de búsqueda no responden ahora mismo. Prueba de nuevo en un momento.</p>
    <p><button class="btn btn-ghost" data-action="retry-search">Reintentar</button></p></div>`;
  const none = `<div class="empty"><h2>Sin resultados</h2><p>No hay nada para «${esc(q)}». Prueba con otras palabras.</p></div>`;

  try {
    if (tab === 'songs' || tab === 'videos') {
      const items = await cachedSearch(tab, q);
      if (!stillHere(token)) return;
      setList(items.map((i) => i.id), label);
      return out(items.length ? `<ol class="tracks" id="tracks">${rows(toPairs(items.map((i) => i.id)))}</ol>` : none);
    }
    if (tab === 'albums' || tab === 'playlists') {
      const items = await cachedSearch(tab, q);
      return out(items.length ? `<div class="grid">${items.map(remoteCard).join('')}</div>` : none);
    }

    // Todo
    const [songs, albums, lists] = await Promise.allSettled([cachedSearch('songs', q), cachedSearch('albums', q), cachedSearch('playlists', q)]);
    if (!stillHere(token)) return;
    const S = songs.status === 'fulfilled' ? songs.value : [];
    const A = albums.status === 'fulfilled' ? albums.value : [];
    const P = lists.status === 'fulfilled' ? lists.value : [];
    if ([songs, albums, lists].every((r) => r.status === 'rejected')) return out(failMsg);
    if (!S.length && !A.length && !P.length) return out(none);
    setList(S.map((s) => s.id), label);
    const top = S[0];
    out(`
      ${top ? `
        <div class="top-grid">
          <section>
            <h2 class="block-title">Resultado principal</h2>
            <div class="top-card" data-id="${top.id}">
              <span class="card-art top-art">${img(top.id)}${EQ}</span>
              <p class="top-title">${esc(top.title)}</p>
              <p class="top-sub"><span class="pill">Canción</span>${esc(top.artist)}</p>
              <button class="play-btn large top-play" data-action="play-from" data-index="0" aria-label="Reproducir ${esc(top.title)}">${icon('play')}</button>
            </div>
          </section>
          <section>
            <h2 class="block-title">Canciones</h2>
            <ol class="tracks">${rows(toPairs(S.slice(0, 4).map((s) => s.id)))}</ol>
          </section>
        </div>` : ''}
      ${A.length ? `<section class="block"><h2>Álbumes</h2><div class="shelf">${A.slice(0, 10).map(remoteCard).join('')}</div></section>` : ''}
      ${P.length ? `<section class="block"><h2>Playlists</h2><div class="shelf">${P.slice(0, 10).map(remoteCard).join('')}</div></section>` : ''}`);
  } catch (err) {
    console.error('[buscar]', err);
    out(failMsg);
  }
}

// ---------- Álbum o playlist de YouTube (sin guardar) ----------
function viewRemote(token) {
  page = null;
  setList([], '');
  const listId = route.arg;
  catalog.getList(listId).then((l) => {
    if (!stillHere(token)) return;
    remember(l.tracks);
    const ids = l.tracks.map((t) => t.id);
    const saved = store.get().playlists.find((p) => p.ytListId === listId);
    const total = l.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    page = { ids, label: l.title };
    setList(ids, l.title);
    $('#view').innerHTML = `
      ${header({
        art: ids[0] ? `<span class="card-art hero-art">${img(ids[0])}</span>` : '<span class="card-art cover-blank hero-art"></span>',
        kind: l.type === 'album' ? 'Álbum' : 'Playlist de YouTube',
        title: l.title || 'Sin título',
        meta: [esc(l.artist), plural(ids.length, 'canción', 'canciones'), total > 60 ? `${Math.round(total / 60)} min` : ''].filter(Boolean).join(', '),
      })}
      <div class="toolbar">
        <button class="play-btn large" data-action="play-all" ${ids.length ? '' : 'disabled'} aria-label="Reproducir">${icon('play')}</button>
        <button class="icon-btn big" data-action="shuffle-all" ${ids.length ? '' : 'disabled'} aria-label="Reproducir en aleatorio" title="Aleatorio">${icon('shuffle')}</button>
        ${saved
          ? `<a class="btn btn-ghost" href="#/playlist/${saved.id}">${icon('check')}En tu biblioteca</a>`
          : `<button class="btn btn-ghost" data-action="save-remote" data-list="${esc(listId)}">${icon('add')}Guardar en tu biblioteca</button>`}
      </div>
      <ol class="tracks" id="tracks">${rows(toPairs(ids))}</ol>`;
    markCurrent();
  }).catch((err) => {
    if (!stillHere(token)) return;
    console.error('[lista]', err);
    $('#view').innerHTML = `
      <div class="empty"><h2>No se ha podido abrir</h2>
      <p>Los servidores no devuelven esta lista ahora mismo. Puedes reintentarlo o importarla con el método de respaldo, que es más lento.</p>
      <p class="btn-row"><button class="btn btn-ghost" data-action="retry-view">Reintentar</button><button class="btn btn-ghost" data-action="import-remote" data-list="${esc(listId)}">Importar con el respaldo</button></p></div>`;
  });
  return '<div class="loading page-loading"><span class="spinner"></span>Abriendo…</div>';
}

// ---------- Cola y "ahora suena" ----------
function renderQueue() {
  if (!player) return;
  const { queue, index, context } = player.getQueue();
  $('#queue-context').textContent = context ? `Reproduciendo desde ${context}` : '';
  $('#queue').innerHTML = queue.length
    ? queue.map((id, i) => {
      const t = trackInfo(id);
      return `
        <li class="row ${i < index ? 'is-past' : ''} ${i === index ? 'is-current' : ''}">
          <button class="row-main" data-action="queue-jump" data-index="${i}">
            <span class="thumb-wrap">${img(id)}${EQ}</span>
            <span class="row-text">
              <span class="row-title">${esc(t.title || 'Título pendiente')}</span>
              <span class="row-artist">${esc(t.artist || '')}</span>
            </span>
          </button>
          ${i !== index ? `<button class="icon-btn" data-action="queue-remove" data-index="${i}" aria-label="Quitar de la cola">${icon('close', 20)}</button>` : ''}
        </li>`;
    }).join('')
    : '<li class="queue-empty">La cola está vacía. Busca algo y dale al play.</li>';
}

function markCurrent() {
  const id = player ? player.current() : null;
  $$('#view [data-id]').forEach((el) => {
    if (el.matches('.row, .card, .top-card')) el.classList.toggle('is-current', el.dataset.id === id);
  });
}

function setAmbient(id) {
  const layers = $$('.amb');
  ambFlip = !ambFlip;
  const on = layers[ambFlip ? 1 : 0];
  const off = layers[ambFlip ? 0 : 1];
  on.style.backgroundImage = `url("${thumb(id)}")`;
  on.classList.add('on');
  off.classList.remove('on');
}

function setNpArt(id) {
  const el = $('#np-art');
  el.src = thumb(id);
  // Intentamos la versión en alta resolución; si no existe, YouTube devuelve una imagen de 120 px
  const hi = new Image();
  hi.onload = () => { if (hi.naturalWidth > 200 && player && player.current() === id) el.src = hi.src; };
  hi.src = thumb(id, 'maxresdefault');
}

/**
 * El color de la portada tiñe el panel "Ahora suena" y su sombra (variable CSS --tint).
 * Leemos la miniatura pequeña en un lienzo de 8×8 y nos quedamos con el píxel más vivo
 * (la media suele salir gris). YouTube deja leer sus miniaturas desde otras webs (CORS).
 */
function setTint(id) {
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    if (!player || player.current() !== id) return;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data;
      let best = null, score = -1;
      for (let i = 0; i < d.length; i += 4) {
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        const s = Math.max(r, gr, b) - Math.min(r, gr, b) + Math.max(r, gr, b) / 4;   // saturación + algo de brillo
        if (s > score) { score = s; best = [r, gr, b]; }
      }
      document.body.style.setProperty('--tint', best.join(', '));
    } catch { /* sin color: se queda el verde de la app */ }
  };
  im.src = thumb(id, 'default');
}

function refreshNowPlaying() {
  const id = player ? player.current() : null;
  document.body.classList.toggle('no-track', !id);
  if (!id) return;
  const s = store.get();
  const t = trackInfo(id);
  const title = t.title || 'Cargando título…';
  $('#bar-art').src = thumb(id);
  $('#bar-title').textContent = title;
  $('#bar-artist').textContent = t.artist || '';
  $('#np-title').textContent = title;
  $('#np-artist').textContent = t.artist || '';
  const liked = s.likes.includes(id);
  $$('[data-like-current]').forEach((b) => {
    b.classList.toggle('on', liked);
    b.setAttribute('aria-pressed', String(liked));
    b.setAttribute('aria-label', liked ? 'Quitar de Me gusta' : 'Añadir a Me gusta');
    b.innerHTML = icon(liked ? 'heart-on' : 'heart');
  });
  if (lastAmbient !== id) { setAmbient(id); setNpArt(id); setTint(id); lastAmbient = id; }
  document.title = `${title}${t.artist ? ` · ${t.artist}` : ''} | KRZ muzic`;
  setMediaMetadata(id, t);
}

function updatePlayButtons(state) {
  const playing = state === 'playing' || state === 'buffering';
  $$('.js-play').forEach((btn) => {
    btn.innerHTML = icon(playing ? 'pause' : 'play');
    btn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  });
}

function updateTime(cur, dur) {
  duration = dur;
  $$('.js-dur').forEach((el) => { el.textContent = clock(dur); });
  if (dragging) return;
  const v = dur ? (cur / dur) * 1000 : 0;
  $$('.js-seek').forEach((el) => { el.value = v; setP(el, v / 10); });
  $$('.js-cur').forEach((el) => { el.textContent = clock(cur); });
}

function updateModes() {
  const { shuffle, repeat, npMode } = store.get().settings;
  $$('[data-action="shuffle"]').forEach((b) => {
    b.classList.toggle('on', shuffle);
    b.setAttribute('aria-pressed', String(shuffle));
  });
  const labels = { off: 'Repetir: desactivado', all: 'Repetir: toda la cola', one: 'Repetir: esta canción' };
  $$('[data-action="repeat"]').forEach((b) => {
    b.classList.toggle('on', repeat !== 'off');
    b.innerHTML = icon(repeat === 'one' ? 'repeat-one' : 'repeat');
    b.setAttribute('aria-label', labels[repeat]);
    b.title = labels[repeat];
  });
  // En la app Android no hay vídeo (el motor nativo solo descarga el audio)
  document.body.classList.toggle('np-video', npMode === 'video' && !(player && player.native));
  $$('[data-action="np-mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === npMode)));
}

function updateVolumeUI() {
  const { volume, muted } = store.get().settings;
  const shown = muted ? 0 : volume;
  const range = $('#volume');
  range.value = shown;
  setP(range, shown);
  const btn = $('#mute-btn');
  btn.innerHTML = icon(shown === 0 ? 'volume-off' : 'volume');
  btn.setAttribute('aria-label', muted ? 'Quitar silencio' : 'Silenciar');
}

function setNp(open) {
  document.body.classList.toggle('np-closed', !open);
  $('#np-btn').classList.toggle('on', open);
  $('#np-btn').setAttribute('aria-expanded', String(open));
}

// ================================================================
// 5. El buscador, como el de YouTube:
//    escribes → autocompletar → eliges (clic o Intro) → suena el primer resultado
//    y se abre la página con el resto de resultados.
// ================================================================
let popItems = [];
let popActive = -1;
let popToken = 0;
const input = () => $('#search-input');
const scope = () => store.get().settings.searchScope || 'songs'; // 'songs' | 'playlists'

/** Busca y reproduce al momento el mejor resultado. */
function runSearch(q) {
  const clean = q.trim();
  if (!clean) return;
  input().value = clean;
  $('.search-clear').hidden = false;
  closeSearchPop();
  store.pushSearch(clean);
  const sc = scope();
  if (sc === 'playlists') {
    cachedSearch('playlists', clean)
      .then((P) => (P[0] ? playRemote(P[0].listId) : toast(`No hay playlists para «${clean}»`)))
      .catch(() => toast('Los servidores de búsqueda no responden. Prueba en un momento.'));
  } else {
    cachedSearch('songs', clean)
      .then((S) => (S.length ? playIds(S.map((s) => s.id), 0, `Búsqueda «${clean}»`) : toast(`No hay canciones para «${clean}»`)))
      .catch(() => toast('Los servidores de búsqueda no responden. Prueba en un momento.'));
  }
  searchTab = sc === 'playlists' ? 'playlists' : 'all';
  const target = `#/search/${encodeURIComponent(clean)}`;
  if (location.hash === target) renderView();
  else location.hash = target;
  if (isMobile()) input().blur();
}

function setScope(sc) {
  store.setSetting('searchScope', sc);
  $$('[data-action="scope"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === sc)));
  input().placeholder = sc === 'playlists' ? 'Buscar playlists de YouTube' : 'Buscar canciones o artistas';
}

function closeSearchPop() {
  const pop = $('#search-pop');
  if (!pop) return;
  pop.hidden = true;
  input().setAttribute('aria-expanded', 'false');
  input().removeAttribute('aria-activedescendant');
  popItems = [];
  popActive = -1;
}

/** Como YouTube: lo que ya escribiste en normal y el resto de la sugerencia en negrita. */
function highlight(suggestion, typed) {
  if (norm(suggestion).startsWith(norm(typed))) {
    return `${esc(suggestion.slice(0, typed.length))}<b>${esc(suggestion.slice(typed.length))}</b>`;
  }
  return `<b>${esc(suggestion)}</b>`;
}

function renderPop(items, typed = '') {
  popItems = items;
  popActive = -1;
  const pop = $('#search-pop');
  if (!items.length) { closeSearchPop(); return; }
  pop.innerHTML = items.map((it, i) => `
    <div class="pop-row">
      <button type="button" class="pop-item" role="option" id="pop-${i}" data-pop="${i}">
        ${icon(it.kind === 'recent' ? 'history' : 'search', 20)}
        <span class="pop-title">${it.kind === 'recent' ? esc(it.q) : highlight(it.q, typed)}</span>
      </button>
      ${it.kind === 'recent' ? `<button type="button" class="pop-remove" data-forget="${esc(it.q)}">Quitar</button>` : ''}
    </div>`).join('');
  pop.hidden = false;
  input().setAttribute('aria-expanded', 'true');
}

async function updatePop() {
  const q = input().value;
  $('.search-clear').hidden = !q.trim();
  const token = ++popToken;
  if (!q.trim()) {
    renderPop(store.get().searches.slice(0, 8).map((r) => ({ kind: 'recent', q: r })));
    return;
  }
  const recents = store.get().searches.filter((r) => norm(r).startsWith(norm(q)) && norm(r) !== norm(q)).slice(0, 2);
  const sug = await catalog.suggestions(q.trim());
  if (token !== popToken || input().value !== q) return;
  const seen = new Set(recents.map(norm));
  const fresh = sug.filter((s) => !seen.has(norm(s))).slice(0, 10 - recents.length);
  const items = [...recents.map((r) => ({ kind: 'recent', q: r })), ...fresh.map((s) => ({ kind: 'suggestion', q: s }))];
  renderPop(items.length ? items : [{ kind: 'suggestion', q: q.trim() }], q);
  // Adelantamos la búsqueda de la primera sugerencia: si la eliges, suena al instante
  const first = items.find((it) => it.kind === 'suggestion');
  if (first) cachedSearch(scope(), first.q).catch(() => {});
}
const updatePopSoon = debounce(updatePop, 120);

function choosePop(i) {
  const it = popItems[i];
  if (it) runSearch(it.q);
}

function movePop(delta) {
  if (!popItems.length) return;
  popActive = (popActive + delta + popItems.length) % popItems.length;
  $$('.pop-item').forEach((el, i) => el.classList.toggle('active', i === popActive));
  const el = $(`#pop-${popActive}`);
  if (el) {
    input().setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
    input().value = popItems[popActive].q; // como YouTube: el texto cambia al moverte con las flechas
    cachedSearch(scope(), popItems[popActive].q).catch(() => {}); // precarga
  }
}

// ================================================================
// 6. Acciones
// ================================================================
function needPlayer() {
  if (player) return true;
  toast('El reproductor aún no está listo. Si no carga, revisa la conexión y recarga la página.');
  return false;
}

function playIds(ids, start, context) {
  if (!ids.length || !needPlayer()) return;
  player.playList(ids, start, { context });
}

async function playRemote(listId) {
  try {
    const l = await catalog.getList(listId);
    remember(l.tracks);
    playIds(l.tracks.map((t) => t.id), 0, l.title);
  } catch {
    toast('No se ha podido cargar esa lista ahora mismo. Prueba otra vez en un momento.');
  }
}

/** Importa una playlist de YouTube a tu biblioteca (o la actualiza si ya estaba). */
async function importPlaylist(listId, { targetId = null } = {}) {
  dialog({ title: 'Leyendo la playlist de YouTube…', body: '<div class="spinner"></div><p>Puede tardar unos segundos.</p>', dismissable: false });
  try {
    let tracks;
    let title;
    try {
      const l = await catalog.getList(listId);
      tracks = l.tracks;
      title = l.title;
    } catch {
      // Respaldo: el reproductor invisible de YouTube (solo ids, hasta ~200)
      const ids = await yt.getPlaylistVideoIds(listId, $('#yt-helper'));
      tracks = ids.map((id) => ({ id }));
      title = await yt.fetchPlaylistTitle(listId);
    }
    if (!tracks.length) throw new Error('vacía');
    closeDialog();
    store.upsertTracks(tracks.map((t) => ({ ...t, inLibrary: false })), { notify: false });
    const ids = tracks.map((t) => t.id);
    let p = targetId ? store.getPlaylist(targetId) : store.get().playlists.find((x) => x.ytListId === listId);
    if (p) {
      store.setPlaylistTracks(p.id, ids);
      toast(`${p.name} actualizada: ${plural(ids.length, 'canción', 'canciones')}`);
    } else {
      p = store.createPlaylist({ name: title || 'Playlist de YouTube', trackIds: ids, source: 'youtube', ytListId: listId });
      toast(`Guardada en tu biblioteca: ${plural(ids.length, 'canción', 'canciones')}`);
    }
    go(`playlist/${p.id}`);
    resolveMissingMeta(ids);
  } catch (err) {
    closeDialog();
    console.error('[import]', err);
    info('No se pudo importar', 'YouTube no ha devuelto la lista. Suele pasar si la playlist es privada o el enlace está incompleto. Las playlists públicas y las «no listadas» sí funcionan.');
  }
}

async function saveRemote(listId) {
  try {
    const l = await catalog.getList(listId);
    const existing = store.get().playlists.find((p) => p.ytListId === listId);
    if (existing) { go(`playlist/${existing.id}`); return; }
    store.upsertTracks(l.tracks.map((t) => ({ ...t, inLibrary: false })), { notify: false });
    const p = store.createPlaylist({ name: l.title || 'Playlist de YouTube', trackIds: l.tracks.map((t) => t.id), source: 'youtube', ytListId: listId });
    toast(`«${p.name}» guardada en tu biblioteca`, [{ label: 'Ver', run: () => go(`playlist/${p.id}`) }]);
  } catch {
    toast('No se ha podido guardar ahora mismo. Prueba otra vez en un momento.');
  }
}

/** Busca títulos que faltan, de 6 en 6 para no saturar */
async function resolveMissingMeta(ids) {
  const todo = [...new Set(ids)].filter((id) => store.get().tracks[id] && !store.get().tracks[id].title && !resolving.has(id));
  if (!todo.length) return;
  todo.forEach((id) => resolving.add(id));
  for (let i = 0; i < todo.length; i += 6) {
    const chunk = todo.slice(i, i + 6);
    const results = await Promise.all(chunk.map(async (id) => {
      const meta = await yt.fetchVideoMeta(id);
      return meta ? { id, ...meta } : null;
    }));
    chunk.forEach((id) => resolving.delete(id));
    const found = results.filter(Boolean);
    if (found.length) store.upsertTracks(found);
    else renderView();
  }
}

// ---------- Playlists ----------
async function newPlaylist({ navigate = true } = {}) {
  const r = await dialog({
    title: 'Nueva playlist',
    input: { label: 'Nombre', value: '' },
    actions: [{ value: 'cancel', label: 'Cancelar' }, { value: 'ok', label: 'Crear', primary: true }],
  });
  if (!r || !r.value) return null;
  const p = store.createPlaylist({ name: r.value });
  if (navigate) go(`playlist/${p.id}`);
  return p;
}

async function pickPlaylist() {
  const { playlists } = store.get();
  const body = `
    <div class="pick">
      ${playlists.map((p) => `
        <button class="pick-item" value="pl:${p.id}">${cover(p)}<span class="ellipsis">${esc(p.name)}</span><span class="muted">${p.trackIds.length}</span></button>`).join('')}
      <button class="pick-item" value="new"><span class="pick-new">${icon('add')}</span><span>Nueva playlist</span></button>
    </div>`;
  const v = await dialog({ title: 'Añadir a una playlist', body, actions: [{ value: 'cancel', label: 'Cancelar' }] });
  if (!v) return null;
  return v === 'new' ? 'new' : v.slice(3);
}

async function addToPlaylistFlow(ids) {
  const choice = await pickPlaylist();
  if (!choice) return;
  const p = choice === 'new' ? await newPlaylist({ navigate: false }) : store.getPlaylist(choice);
  if (!p) return;
  ensureStored(ids);
  const added = store.addToPlaylist(p.id, ids);
  toast(added ? `Añadida a ${p.name}` : `Ya estaba en ${p.name}`, [{ label: 'Ver', run: () => go(`playlist/${p.id}`) }]);
}

async function renamePlaylist(p) {
  const r = await dialog({
    title: 'Cambiar nombre',
    input: { label: 'Nombre', value: p.name },
    actions: [{ value: 'cancel', label: 'Cancelar' }, { value: 'ok', label: 'Guardar', primary: true }],
  });
  if (r && r.value) store.renamePlaylist(p.id, r.value);
}

async function deletePlaylist(p) {
  const ok = await confirmDialog({ title: '¿Eliminar la playlist?', body: `Se borrará «${p.name}». Las canciones guardadas seguirán en Canciones.`, confirm: 'Eliminar', danger: true });
  if (!ok) return;
  store.deletePlaylist(p.id);
  toast('Playlist eliminada');
  go('home');
}

async function refreshPlaylist(p) {
  const ok = await confirmDialog({
    title: '¿Actualizar desde YouTube?',
    body: 'Las canciones de esta playlist se sustituirán por las que tenga ahora en YouTube. Si añadiste alguna a mano, se quitará de aquí.',
    confirm: 'Actualizar',
  });
  if (ok) importPlaylist(p.ytListId, { targetId: p.id });
}

async function deleteTrack(id) {
  const t = trackInfo(id);
  const ok = await confirmDialog({
    title: '¿Eliminar de la biblioteca?',
    body: `«${t.title || 'Esta canción'}» se quitará de Canciones, de Me gusta y de todas tus playlists.`,
    confirm: 'Eliminar',
    danger: true,
  });
  if (ok) { store.removeTrack(id); toast('Canción eliminada'); }
}

// ---------- Menús ⋮ ----------
function openTrackMenu(anchor, id, pos) {
  const p = route.name === 'playlist' ? store.getPlaylist(route.arg) : null;
  const saved = store.get().tracks[id]?.inLibrary;
  openMenu(anchor, [
    { icon: 'next-up', label: 'Reproducir a continuación', run: () => { if (needPlayer()) { player.playNext(id); toast('Sonará a continuación'); } } },
    { icon: 'queue', label: 'Añadir a la cola', run: () => { if (needPlayer()) { player.addToQueue(id); toast('Añadida a la cola'); } } },
    !saved && { icon: 'add', label: 'Guardar en Canciones', run: () => { ensureStored([id], { save: true }); toast('Guardada en Canciones'); } },
    { icon: 'playlist-add', label: 'Añadir a una playlist…', run: () => addToPlaylistFlow([id]) },
    { icon: 'search', label: 'Buscar más del artista', run: () => { const a = trackInfo(id).artist; if (a) { input().value = a; goSearch(a); } } },
    p && pos > 0 && { icon: 'up', label: 'Subir', run: () => store.moveInPlaylist(p.id, pos, pos - 1) },
    p && pos < p.trackIds.length - 1 && { icon: 'down', label: 'Bajar', run: () => store.moveInPlaylist(p.id, pos, pos + 1) },
    p && { icon: 'close', label: 'Quitar de esta playlist', run: () => { store.removeFromPlaylist(p.id, pos); toast(`Quitada de ${p.name}`); } },
    { icon: 'open', label: 'Abrir en YouTube', run: () => window.open(`https://www.youtube.com/watch?v=${id}`, '_blank', 'noopener') },
    {
      icon: 'link',
      label: 'Copiar enlace',
      run: async () => {
        try { await navigator.clipboard.writeText(`https://youtu.be/${id}`); toast('Enlace copiado'); } catch { toast('No se pudo copiar el enlace'); }
      },
    },
    route.name === 'songs' && { icon: 'delete', label: 'Eliminar de la biblioteca', danger: true, run: () => deleteTrack(id) },
  ]);
}

function openPlaylistMenu(anchor) {
  const p = store.getPlaylist(route.arg);
  if (!p) return;
  openMenu(anchor, [
    { icon: 'edit', label: 'Cambiar nombre', run: () => renamePlaylist(p) },
    p.source === 'youtube' && { icon: 'refresh', label: 'Actualizar desde YouTube', run: () => refreshPlaylist(p) },
    p.source === 'youtube' && { icon: 'open', label: 'Abrir en YouTube', run: () => window.open(`https://www.youtube.com/playlist?list=${p.ytListId}`, '_blank', 'noopener') },
    { icon: 'delete', label: 'Eliminar playlist', danger: true, run: () => deletePlaylist(p) },
  ]);
}

// ---------- Modos y volumen ----------
function setShuffle(on) {
  store.setSetting('shuffle', on);
  if (player) player.setShuffle(on);
  updateModes();
}
function cycleRepeat() {
  const next = { off: 'all', all: 'one', one: 'off' }[store.get().settings.repeat] || 'off';
  store.setSetting('repeat', next);
  if (player) player.setRepeat(next);
  updateModes();
}
function toggleMute() {
  const muted = !store.get().settings.muted;
  store.setSetting('muted', muted);
  if (player) player.setMuted(muted);
  updateVolumeUI();
}

// ---------- Copia de seguridad ----------
async function backup() {
  const v = await dialog({
    title: 'Copia de seguridad',
    body: '<p>Tu biblioteca se guarda solo en este navegador. Descarga una copia de vez en cuando, o úsala para llevar tu música a otro dispositivo.</p>',
    actions: [{ value: 'cancel', label: 'Cerrar' }, { value: 'import', label: 'Restaurar copia' }, { value: 'export', label: 'Descargar copia', primary: true }],
  });
  if (v === 'export') {
    const name = `krz-muzic-copia-${new Date().toISOString().slice(0, 10)}.json`;
    // En la app Android el WebView no descarga archivos: Android abre "Guardar como" (y avisa él)
    if (window.KRZNative && window.KRZNative.saveBackup) return window.KRZNative.saveBackup(store.exportData(), name);
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Copia descargada');
  } else if (v === 'import') {
    $('#import-file').click();
  }
}

async function restoreFromFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.tracks !== 'object' || !Array.isArray(data.playlists)) throw new Error('formato');
    const ok = await confirmDialog({
      title: '¿Restaurar esta copia?',
      body: `Tiene ${plural(Object.keys(data.tracks).length, 'canción', 'canciones')} y ${plural(data.playlists.length, 'playlist', 'playlists')}. Sustituirá todo lo que hay ahora en la app.`,
      confirm: 'Restaurar',
      danger: true,
    });
    if (!ok) return;
    store.importData(data);
    updateModes();
    updateVolumeUI();
    toast('Copia restaurada');
    go('home');
  } catch {
    info('No se pudo restaurar', 'Ese archivo no es una copia de KRZ muzic válida.');
  }
}

// ================================================================
// 7. Conectar con el reproductor
// ================================================================
function saveSession() {
  if (!player) return;
  const snap = player.snapshot();
  if (snap.queue.length) {
    ensureStored(snap.queue.filter((id) => !store.get().tracks[id] && metaCache.has(id)));
    store.saveSession(snap);
  }
}

const ERRORS = {
  2: 'El enlace de ese vídeo no es válido. Paso a la siguiente.',
  5: 'El reproductor de YouTube ha fallado con ese vídeo. Paso a la siguiente.',
  100: 'Ese vídeo ya no existe o es privado. Paso a la siguiente.',
  101: 'Ese vídeo no permite reproducirse fuera de YouTube. Paso a la siguiente.',
  150: 'Ese vídeo no permite reproducirse fuera de YouTube. Paso a la siguiente.',
  native: 'No se pudo cargar el audio de esa canción. Paso a la siguiente.',
  153: 'YouTube no sabe desde qué web lo llamas. Abre la app con iniciar.bat (http://localhost), no con doble clic en index.html.',
};

const handlers = {
  /** Datos de una canción para la notificación de Android (título, artista y carátula). */
  describe(id) {
    const t = trackInfo(id);
    return { title: t.title || '', artist: t.artist || '', thumb: thumb(id, 'hqdefault') };
  },
  onTrack(id, { restored }) {
    playCounted = false;
    if (!store.get().tracks[id]) ensureStored([id]);
    if (!restored) store.pushRecent(id);
    refreshNowPlaying();
    markCurrent();
    saveSession();
    if (route.name === 'home' && !restored) renderView();
    setTimeout(() => $('#queue .is-current')?.scrollIntoView({ block: 'nearest' }), 50);
  },
  onState(state) {
    document.body.classList.toggle('is-playing', state === 'playing');
    updatePlayButtons(state);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state === 'paused' ? 'paused' : 'playing';
    if (state === 'paused') saveSession();
  },
  onTime(cur, dur) {
    updateTime(cur, dur);
    const id = player && player.current();
    // Una escucha cuenta a partir de 30 s (o al llegar casi al final si la canción es más corta)
    if (id && !playCounted && (cur >= 30 || (dur > 0 && cur >= dur - 1))) {
      playCounted = true;
      store.recordPlay(id);
    }
    const t = id && store.get().tracks[id];
    if (t && !t.duration && dur > 0 && !durationSaved.has(id)) {
      durationSaved.add(id);
      store.upsertTracks([{ id, duration: Math.round(dur) }], { notify: false });
    }
  },
  onMeta(id, title, author) {
    // Si no teníamos el título, lo cogemos del propio reproductor
    const t = store.get().tracks[id];
    if (t && !t.title && title) store.upsertTracks([{ id, ...yt.cleanMeta(title, author) }]);
  },
  onQueue() {
    renderQueue();
    saveSession();
  },
  onError(id, code) {
    document.body.classList.remove('is-playing');
    updatePlayButtons('paused');
    toast(ERRORS[code] || `YouTube devolvió un error (${code}).`);
  },
};

function setMediaMetadata(id, t) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || 'KRZ muzic',
    artist: t.artist || '',
    album: player ? player.getQueue().context : '',
    artwork: [{ src: thumb(id, 'hqdefault'), sizes: '480x360', type: 'image/jpeg' }],
  });
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* no soportado */ } };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('previoustrack', () => player.prev());
  set('nexttrack', () => player.next());
  set('seekto', (d) => player.seek(d.seekTime));
}

// ================================================================
// 8. Escuchar eventos
// ================================================================
/** Latido del corazón al dar Me gusta. Espera un momento: algunas pantallas (Buscar) se rellenan justo después de redibujarse. */
function beat(id) {
  if (!store.get().likes.includes(id)) return;
  const sel = [`[data-action="like"][data-id="${id}"]`];
  if (player && player.current() === id) sel.push('[data-like-current]');
  setTimeout(() => $$(sel.join(', ')).forEach((b) => {
    b.classList.remove('beat');
    void b.offsetWidth;   // reinicia la animación si ya estaba puesta
    b.classList.add('beat');
    b.addEventListener('animationend', () => b.classList.remove('beat'), { once: true });
  }), 0);
}

/**
 * Gestos del móvil:
 *  - En la barra de abajo: deslizar a la izquierda = siguiente, a la derecha = anterior.
 *  - En "Ahora suena": deslizar hacia abajo (estando arriba del todo) lo cierra.
 */
function bindGestures() {
  const track = $('.bar-track');
  let x0 = null, dx = 0, swiped = 0;
  track.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0; }, { passive: true });
  track.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    dx = e.touches[0].clientX - x0;
    track.style.transform = `translateX(${dx * 0.4}px)`;
    track.style.opacity = String(1 - Math.min(Math.abs(dx) / 300, 0.5));
  }, { passive: true });
  track.addEventListener('touchend', () => {
    track.style.transform = '';
    track.style.opacity = '';
    if (x0 !== null && Math.abs(dx) > 60 && needPlayer()) {
      swiped = Date.now();
      if (dx < 0) player.next(); else player.prev();
    }
    x0 = null;
  });
  // Tras deslizar, el "clic" que manda el navegador al soltar no debe abrir el panel
  track.addEventListener('click', (e) => { if (Date.now() - swiped < 500) e.stopPropagation(); }, true);

  const np = $('#np');
  let y0 = null, dy = 0;
  np.addEventListener('touchstart', (e) => {
    const can = isMobile() && !document.body.classList.contains('np-closed') && np.scrollTop <= 0 && !e.target.closest('input');
    y0 = can ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  np.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    np.style.transition = 'none';
    np.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  np.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    np.style.transition = '';
    np.style.transform = '';
    if (dy > 110) setNp(false);
  });
}

function bindEvents() {
  // Delegación de eventos: un solo oyente para todos los botones con data-action
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    const index = Number(el.dataset.index);
    const pos = Number(el.dataset.pos);

    switch (action) {
      case 'play-from': playIds(listCtx.ids, index, listCtx.label); break;
      case 'play-all': setShuffle(false); playIds(listCtx.ids, 0, listCtx.label); break;
      case 'shuffle-all':
        if (listCtx.ids.length) { setShuffle(true); playIds(listCtx.ids, Math.floor(Math.random() * listCtx.ids.length), listCtx.label); }
        break;
      case 'play-playlist': { const p = store.getPlaylist(id); if (p) playIds(p.trackIds, 0, p.name); break; }
      case 'play-likes': playIds(store.get().likes, 0, 'Me gusta'); break;
      case 'play-remote': playRemote(el.dataset.list); break;
      case 'play-slide': playIds(sliderList.map((t) => t.id), index, 'Lo que suena'); break;
      case 'slide': sliderTouched = Date.now(); moveSlider(Number(el.dataset.dir)); break;
      case 'play-reco': {
        const list = el.dataset.list === 'artist' ? recoData?.artistPicks : recoData?.picks;
        if (list) playIds(list.map((t) => t.id), index, el.dataset.list === 'artist' ? `Más de ${recoData.topArtist}` : 'Recomendado para ti');
        break;
      }
      case 'play-mix': {
        const m = recoData?.mixes.find((x) => x.seedId === el.dataset.seed);
        if (m) playIds([m.seedId, ...m.tracks.map((t) => t.id).filter((x) => x !== m.seedId)], 0, `Mix de ${m.artist}`);
        break;
      }
      case 'refresh-reco': toast('Actualizando recomendaciones…'); ensureReco({ force: true }); if (route.name === 'foryou') renderView(); break;
      case 'save-remote': saveRemote(el.dataset.list); break;
      case 'diag-refresh': renderView(); break;
      case 'diag-share': shareLog(); break;
      case 'diag-clear':
        confirmDialog({ title: 'Borrar el registro', body: 'Se borra todo lo apuntado hasta ahora. ¿Seguro?', confirm: 'Borrar', danger: true })
          .then((ok) => { if (ok) { window.KRZNative.clearLog(); renderView(); } });
        break;
      case 'import-remote': importPlaylist(el.dataset.list); break;
      case 'like':
        ensureStored([id]);
        store.toggleLike(id);
        beat(id);
        break;
      case 'like-current': if (player && player.current()) { const cur = player.current(); ensureStored([cur]); store.toggleLike(cur); beat(cur); } break;
      case 'slide-to': { const s = $('#slider'); if (s) { sliderTouched = Date.now(); s.scrollTo({ left: index * slideStep(s), behavior: 'smooth' }); } break; }
      case 'track-menu': openTrackMenu(el, id, pos); break;
      case 'playlist-menu': openPlaylistMenu(el); break;
      case 'new-playlist': newPlaylist(); break;
      case 'queue-jump': if (player) player.jump(index); break;
      case 'queue-remove': if (player) player.removeAt(index); break;
      case 'toggle-play': if (needPlayer()) player.toggle(); break;
      case 'prev': if (needPlayer()) player.prev(); break;
      case 'next': if (needPlayer()) player.next(); break;
      case 'shuffle': setShuffle(!store.get().settings.shuffle); break;
      case 'repeat': cycleRepeat(); break;
      case 'mute': toggleMute(); break;
      case 'toggle-np': setNp(document.body.classList.contains('np-closed')); break;
      case 'np-mode': store.setSetting('npMode', el.dataset.mode); updateModes(); break;
      case 'go-search': runSearch(el.dataset.q); break;
      case 'scope': setScope(el.dataset.scope); input().focus(); updatePop(); break;
      case 'add-current': if (player && player.current()) addToPlaylistFlow([player.current()]); break;
      case 'forget-search': store.removeSearch(el.dataset.q); renderView(); break;
      case 'search-tab': searchTab = el.dataset.tab; renderView(); break;
      case 'retry-search': searchCache.clear(); renderView(); break;
      case 'retry-view': renderView(); break;
      case 'clear-search': input().value = ''; input().focus(); updatePop(); break;
      case 'backup': backup(); break;
      case 'install':
        if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; $('#install-btn').hidden = true; renderView(); }); }
        break;
      default: break;
    }
  });

  // --- Buscador ---
  const inp = input();
  inp.addEventListener('input', updatePopSoon);
  inp.addEventListener('focus', () => updatePop());
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePop(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePop(-1); }
    else if (e.key === 'Escape') { if ($('#search-pop').hidden) inp.blur(); else closeSearchPop(); }
    else if (e.key === 'Enter' && popActive >= 0) { e.preventDefault(); choosePop(popActive); }
  });
  $('#search-pop').addEventListener('click', (e) => {
    const forget = e.target.closest('[data-forget]');
    if (forget) { store.removeSearch(forget.dataset.forget); updatePop(); return; }
    const b = e.target.closest('[data-pop]');
    if (b) choosePop(Number(b.dataset.pop));
  });
  $('#search-pop').addEventListener('pointerdown', (e) => e.preventDefault()); // que el input no pierda el foco
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) closeSearchPop(); });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(inp.value);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'filter') { filter = e.target.value; refilter(); }
  });

  // --- Barras de progreso: mientras arrastras solo mostramos el tiempo; al soltar, saltamos ---
  $$('.js-seek').forEach((seek) => {
    seek.addEventListener('input', () => {
      dragging = true;
      setP(seek, seek.value / 10);
      $$('.js-cur').forEach((el) => { el.textContent = clock((seek.value / 1000) * duration); });
    });
    seek.addEventListener('change', () => {
      if (player && duration) player.seek((seek.value / 1000) * duration);
      dragging = false;
    });
  });

  const vol = $('#volume');
  vol.addEventListener('input', () => {
    const v = Number(vol.value);
    store.setSetting('volume', v);
    store.setSetting('muted', v === 0);
    if (player) { player.setVolume(v); player.setMuted(v === 0); }
    updateVolumeUI();
  });

  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) restoreFromFile(file);
  });

  $('#main').addEventListener('scroll', closeMenu, { passive: true });
  document.addEventListener('pointerdown', (e) => { if (e.target.closest('#slider')) sliderTouched = Date.now(); });
  document.addEventListener('wheel', (e) => { if (e.target.closest && e.target.closest('#slider')) sliderTouched = Date.now(); }, { passive: true });
  // "scroll" no sube hasta document, pero sí se puede escuchar en la fase de captura (true)
  document.addEventListener('scroll', (e) => { if (e.target.id === 'slider') updateDots(); }, true);
  bindGestures();

  // --- Atajos de teclado (los mismos que en YouTube) ---
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]') || $('#dialog').open) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); input().focus(); return; }
    if (e.key === 'Escape' && isMobile() && !document.body.classList.contains('np-closed')) { setNp(false); return; }
    if (!player) return;
    if ((e.key === ' ' && !e.target.closest('button, a')) || e.key === 'k') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'j') player.seekBy(-10);
    else if (e.key === 'l') player.seekBy(10);
    else if (e.key === 'N' && e.shiftKey) player.next();
    else if (e.key === 'P' && e.shiftKey) player.prev();
    else if (e.key === 'm') toggleMute();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    $('#install-btn').hidden = false;
    if (route.name === 'home') renderView();
  });
  window.addEventListener('appinstalled', () => { $('#install-btn').hidden = true; });
  window.addEventListener('pagehide', saveSession);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });
}

// ================================================================
// 9. Arranque
// ================================================================
async function init() {
  // Sustituye cada <span data-icon="x"> del HTML por su icono SVG
  $$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

  const session = store.loadSession();
  store.prune(session?.queue || []);
  rememberReco();
  if (popularData) remember(popularData.tracks);

  route = parseHash();
  if (route.name === 'search') input().value = route.arg;
  setScope(scope());
  setNp(innerWidth > 1100);
  updateModes();
  updateVolumeUI();
  updatePlayButtons('paused');
  renderAll();
  store.subscribe(renderAll);
  bindEvents();

  // Quitamos la pantalla de bienvenida cuando la app ya está dibujada (mínimo 0,7 s para que se vea el logo)
  const splash = $('#splash');
  setTimeout(() => {
    splash.classList.add('gone');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }, Math.max(0, 700 - performance.now()));

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err));
  }

  if (location.protocol === 'file:') {
    info('Abre la app desde un servidor', 'Has abierto index.html con doble clic (file://). Así YouTube no reproduce nada. Cierra esta pestaña y haz doble clic en iniciar.bat, dentro de la misma carpeta.');
  }

  try {
    player = await createPlayer('yt-player', handlers, store.get().settings);
    document.body.classList.toggle('is-native', player.native);
    updateModes();
    setupMediaSession();
    if (session) player.restore(session);
    renderQueue();
  } catch (err) {
    console.error('[player]', err);
    toast('No se pudo conectar con YouTube. Comprueba tu conexión y recarga la página.', [], 10000);
  }

  resolveMissingMeta(Object.values(store.get().tracks).filter((t) => !t.title).map((t) => t.id));
}

init();
