// recommend.js — Recomendaciones basadas en lo que escuchas.
//
// Cómo funciona, en tres pasos:
//  1) Perfil de gustos: cada canción suma puntos por escuchas (+1 cada vez que la oyes 30 s),
//     por "Me gusta" (+3) y por haberla oído hace poco (hasta +1). Sumando por artista
//     sabemos quiénes son tus artistas principales.
//  2) Semillas: tu mejor canción de cada uno de tus 3 artistas principales.
//     De cada semilla pedimos su "Mix" de YouTube (unas 25 canciones parecidas).
//  3) Recomendaciones: canciones de esos mixes que aún no conoces. Las que aparecen
//     en varios mixes a la vez van primero: encajan con más de uno de tus gustos.
//
// El resultado se guarda para que la sección abra al instante y solo se recalcula
// cuando cambian tus gustos (y han pasado 20 min) o han pasado 6 horas.

import { store } from './store.js';
import * as catalog from './catalog.js';
import { norm } from './ui.js';

const KEY = 'krz-muzic:reco';
const MAX_AGE = 6 * 60 * 60 * 1000;   // 6 horas
const MIN_REFRESH = 20 * 60 * 1000;   // 20 minutos

/** "Bad Bunny, Drake" o "Rosalía ft. Björk" → el primer artista */
export const mainArtist = (a) => String(a || '').split(/,|&| feat\.?| ft\.?| x | y /i)[0].trim();

export function tasteProfile() {
  const s = store.get();
  const plays = (s.stats && s.stats.plays) || {};
  const score = {};
  const add = (id, points) => { if (s.tracks[id]) score[id] = (score[id] || 0) + points; };
  Object.entries(plays).forEach(([id, n]) => add(id, n));
  s.likes.forEach((id) => add(id, 3));
  s.recent.slice(0, 10).forEach((id, i) => add(id, (10 - i) / 10));

  const tracks = Object.entries(score)
    .sort((a, b) => b[1] - a[1])
    .map(([id, points]) => ({ id, points, artist: mainArtist(s.tracks[id].artist) }));

  const byArtist = {};
  tracks.forEach((t) => { if (t.artist) byArtist[t.artist] = (byArtist[t.artist] || 0) + t.points; });
  const artists = Object.entries(byArtist).sort((a, b) => b[1] - a[1]).map(([a]) => a);

  const seeds = [];
  const usedArtists = new Set();
  for (const t of tracks) {
    const key = norm(t.artist || t.id);
    if (usedArtists.has(key)) continue;
    usedArtists.add(key);
    seeds.push(t);
    if (seeds.length === 3) break;
  }

  const known = new Set([...Object.keys(plays), ...s.recent, ...s.likes,
    ...Object.values(s.tracks).filter((t) => t.inLibrary).map((t) => t.id)]);
  return { seeds, artists: artists.slice(0, 4), known };
}

export function getCached() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function saveCache(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* sin espacio */ }
}

/** ¿Hace falta recalcular? */
export function isStale() {
  const prof = tasteProfile();
  if (!prof.seeds.length) return false;
  const cached = getCached();
  if (!cached) return true;
  const age = Date.now() - cached.at;
  const basis = prof.seeds.map((t) => t.id).join(',');
  return age > MAX_AGE || (basis !== cached.basis && age > MIN_REFRESH);
}

export async function buildRecommendations() {
  const prof = tasteProfile();
  if (!prof.seeds.length) return null;
  const s = store.get();

  const results = await Promise.allSettled(prof.seeds.map((t) => catalog.getMix(t.id)));
  const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : []));

  // Contamos en cuántos mixes aparece cada canción nueva (sin repetir la misma canción subida dos veces)
  const tally = new Map();
  const seenSong = new Set();
  lists.forEach((list) => list.forEach((t, pos) => {
    if (prof.known.has(t.id)) return;
    const songKey = norm(`${t.title}|${mainArtist(t.artist)}`);
    let entry = tally.get(t.id);
    if (!entry) {
      if (seenSong.has(songKey)) return;
      seenSong.add(songKey);
      entry = { t, hits: 0, best: Infinity };
      tally.set(t.id, entry);
    }
    entry.hits += 1;
    entry.best = Math.min(entry.best, pos);
  }));
  const picks = [...tally.values()]
    .sort((a, b) => b.hits - a.hits || a.best - b.best)
    .slice(0, 30)
    .map((e) => e.t);

  // Más de tu artista favorito
  const topArtist = prof.artists[0] || '';
  let artistPicks = [];
  if (topArtist) {
    try {
      const songs = await catalog.searchSongs(topArtist);
      artistPicks = songs.filter((t) => !prof.known.has(t.id) && norm(t.artist).includes(norm(topArtist))).slice(0, 12);
    } catch { /* sin conexión con el buscador: seguimos sin esta parte */ }
  }

  const mixes = prof.seeds.map((seed, i) => {
    const tracks = lists[i];
    const others = [...new Set(tracks.filter((t) => t.id !== seed.id).map((t) => mainArtist(t.artist)).filter((a) => a && norm(a) !== norm(seed.artist)))].slice(0, 3);
    return { seedId: seed.id, artist: seed.artist || s.tracks[seed.id].title, others, tracks };
  }).filter((m) => m.tracks.length);

  if (!mixes.length && !artistPicks.length) throw new Error('Sin datos para recomendar');

  const data = {
    basis: prof.seeds.map((t) => t.id).join(','),
    at: Date.now(),
    artists: prof.artists,
    mixes,
    picks,
    topArtist,
    artistPicks,
  };
  saveCache(data);
  return data;
}
