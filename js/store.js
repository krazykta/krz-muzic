// store.js — El "almacén" de datos de la app.
// Todo lo que guardas (canciones, playlists, me gusta…) vive aquí y se guarda
// en localStorage: un pequeño espacio de almacenamiento que tiene cada web
// dentro de tu navegador. No hay servidor: los datos son solo tuyos y de ese navegador.

const KEY = 'krz-muzic:v1';            // nombre del "cajón" en localStorage
const SESSION_KEY = 'krz-muzic:session'; // la cola que estaba sonando

function emptyState() {
  return {
    version: 1,
    // { [idDeVideo]: { id, title, artist, duration, addedAt, inLibrary } }
    // inLibrary = false → la escuchaste desde el buscador pero no la has guardado
    tracks: {},
    playlists: [],  // [{ id, name, trackIds, source: 'local'|'youtube', ytListId, createdAt, updatedAt }]
    likes: [],      // ids de canciones con "Me gusta" (la más reciente primero)
    recent: [],     // últimas canciones que has escuchado
    searches: [],   // últimas búsquedas
    stats: { plays: {} }, // { plays: { [id]: veces que la has escuchado al menos 30 s } }
    settings: { volume: 80, muted: false, repeat: 'off', shuffle: false, npMode: 'song' },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const data = JSON.parse(raw);
    const base = emptyState();
    const merged = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
    // Migración: las canciones guardadas antes de existir inLibrary eran todas de tu biblioteca
    Object.values(merged.tracks).forEach((t) => { if (t.inLibrary === undefined) t.inLibrary = true; });
    return merged;
  } catch (err) {
    console.warn('[store] Los datos guardados están dañados; empiezo de cero.', err);
    return emptyState();
  }
}

let state = load();
const listeners = new Set();

// Guarda en localStorage y, si notify es true, avisa a quien esté escuchando
// (la interfaz) para que se vuelva a dibujar con los datos nuevos.
function save({ notify = true } = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('[store] No se pudo guardar', err);
  }
  if (notify) listeners.forEach((fn) => fn(state));
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => Date.now();
// Quita campos vacíos para que un dato "sin título" no borre un título que ya teníamos.
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const store = {
  get: () => state,

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---- Canciones ----
  upsertTracks(list, { notify = true } = {}) {
    // "upsert" = update + insert: si existe la actualiza, si no la crea.
    // inLibrary nunca pasa de true a false: guardar es para siempre hasta que la borres.
    for (const t of list) {
      const old = state.tracks[t.id];
      const rec = { id: t.id, title: '', artist: '', duration: 0, addedAt: now(), ...old, ...compact(t) };
      rec.inLibrary = old ? Boolean(old.inLibrary || t.inLibrary === true) : t.inLibrary !== false;
      if (!old?.inLibrary && rec.inLibrary) rec.addedAt = now();
      state.tracks[t.id] = rec;
    }
    save({ notify });
  },

  /** Quita canciones de búsquedas que ya no aparecen en ningún sitio (para no llenar el almacenamiento). */
  prune(keep = []) {
    const used = new Set([...keep, ...state.likes, ...state.recent, ...Object.keys(state.stats?.plays || {}), ...state.playlists.flatMap((p) => p.trackIds)]);
    let removed = 0;
    for (const [id, t] of Object.entries(state.tracks)) {
      if (!t.inLibrary && !used.has(id)) { delete state.tracks[id]; removed++; }
    }
    if (removed) save({ notify: false });
  },

  removeTrack(id) {
    delete state.tracks[id];
    state.playlists.forEach((p) => { p.trackIds = p.trackIds.filter((x) => x !== id); });
    state.likes = state.likes.filter((x) => x !== id);
    state.recent = state.recent.filter((x) => x !== id);
    save();
  },

  // ---- Playlists ----
  getPlaylist: (id) => state.playlists.find((p) => p.id === id) || null,

  createPlaylist({ name, trackIds = [], source = 'local', ytListId = null }) {
    const p = { id: uid(), name, trackIds: [...trackIds], source, ytListId, createdAt: now(), updatedAt: now() };
    state.playlists.push(p);
    save();
    return p;
  },

  renamePlaylist(id, name) {
    const p = store.getPlaylist(id);
    if (!p) return;
    p.name = name;
    p.updatedAt = now();
    save();
  },

  deletePlaylist(id) {
    state.playlists = state.playlists.filter((p) => p.id !== id);
    save();
  },

  setPlaylistTracks(id, ids) {
    const p = store.getPlaylist(id);
    if (!p) return;
    p.trackIds = [...ids];
    p.updatedAt = now();
    save();
  },

  /** Añade canciones sin duplicarlas. Devuelve cuántas eran nuevas. */
  addToPlaylist(id, ids) {
    const p = store.getPlaylist(id);
    if (!p) return 0;
    const already = new Set(p.trackIds);
    const fresh = ids.filter((x) => !already.has(x));
    p.trackIds.push(...fresh);
    ids.forEach((x) => { if (state.tracks[x]) state.tracks[x].inLibrary = true; });
    p.updatedAt = now();
    save();
    return fresh.length;
  },

  removeFromPlaylist(id, index) {
    const p = store.getPlaylist(id);
    if (!p) return;
    p.trackIds.splice(index, 1);
    p.updatedAt = now();
    save();
  },

  moveInPlaylist(id, from, to) {
    const p = store.getPlaylist(id);
    if (!p || to < 0 || to >= p.trackIds.length) return;
    const [moved] = p.trackIds.splice(from, 1);
    p.trackIds.splice(to, 0, moved);
    p.updatedAt = now();
    save();
  },

  // ---- Me gusta y recientes ----
  toggleLike(id) {
    const i = state.likes.indexOf(id);
    if (i >= 0) state.likes.splice(i, 1);
    else {
      state.likes.unshift(id);
      if (state.tracks[id]) state.tracks[id].inLibrary = true;
    }
    save();
    return i < 0;
  },

  pushRecent(id) {
    state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 30);
    save({ notify: false });
  },

  /** Suma una escucha (la app la llama cuando llevas 30 s de canción). */
  recordPlay(id) {
    if (!state.stats || !state.stats.plays) state.stats = { plays: {} };
    state.stats.plays[id] = (state.stats.plays[id] || 0) + 1;
    save({ notify: false });
  },

  pushSearch(q) {
    const clean = q.trim();
    if (!clean) return;
    state.searches = [clean, ...state.searches.filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, 8);
    save({ notify: false });
  },

  removeSearch(q) {
    state.searches = state.searches.filter((x) => x !== q);
    save({ notify: false });
  },

  // ---- Ajustes (volumen, aleatorio, repetir) ----
  setSetting(key, value) {
    state.settings[key] = value;
    save({ notify: false });
  },

  // ---- Copia de seguridad ----
  exportData: () => JSON.stringify(state, null, 2),

  importData(data) {
    const base = emptyState();
    state = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
    Object.values(state.tracks).forEach((t) => { if (t.inLibrary === undefined) t.inLibrary = true; });
    save();
  },

  // ---- Sesión (para seguir donde lo dejaste al recargar) ----
  loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  },
  saveSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* sin espacio: no pasa nada */ }
  },
};
