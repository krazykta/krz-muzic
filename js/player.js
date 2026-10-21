// player.js — El motor de reproducción.
// Envuelve el reproductor de YouTube y añade lo que YouTube no trae:
// una cola propia, aleatorio, repetir y pasar a la siguiente canción sola.
// No sabe nada de la interfaz: solo avisa de lo que pasa mediante "handlers"
// (funciones que app.js le entrega para que las llame en cada evento).

import { loadYouTubeAPI } from './youtube.js';

// Estados que devuelve YouTube
const ENDED = 0, PLAYING = 1, BUFFERING = 3;

function shuffled(arr) {
  // Algoritmo de Fisher-Yates: baraja de forma justa
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function createPlayer(elementId, handlers = {}, settings = {}) {
  const YT = await loadYouTubeAPI();
  const h = handlers;

  let yt = null;          // el reproductor de YouTube
  let queue = [];         // orden en que van a sonar
  let original = [];      // orden original (para poder quitar el aleatorio)
  let index = -1;         // posición de la canción actual dentro de queue
  let context = '';       // de dónde viene la cola ("Me gusta", nombre de playlist…)
  let repeat = settings.repeat || 'off'; // 'off' | 'all' | 'one'
  let shuffle = !!settings.shuffle;
  let timer = null;

  await new Promise((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error('player-timeout')), 20000);
    new YT.Player(elementId, {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,        // ocultamos los controles de YouTube: usamos los nuestros
        disablekb: 1,
        rel: 0,
        iv_load_policy: 3,  // sin anotaciones
        playsinline: 1,     // en iPhone, que no se abra a pantalla completa
        fs: 0,
        origin: location.origin,
      },
      events: {
        onReady: (e) => { clearTimeout(failTimer); yt = e.target; resolve(); },
        onStateChange: (e) => onState(e.data),
        onError: (e) => onError(e.data),
      },
    });
  });

  yt.setVolume(settings.volume ?? 80);
  if (settings.muted) yt.mute();

  // ---------- Eventos internos ----------
  const time = () => (yt.getCurrentTime && yt.getCurrentTime()) || 0;
  const dur = () => (yt.getDuration && yt.getDuration()) || 0;
  const emitTime = () => h.onTime && h.onTime(time(), dur());
  const startTimer = () => { stopTimer(); timer = setInterval(emitTime, 250); };
  const stopTimer = () => { clearInterval(timer); timer = null; };

  function onState(s) {
    if (s === PLAYING) {
      startTimer();
      const data = yt.getVideoData && yt.getVideoData();
      if (data && data.title && h.onMeta) h.onMeta(current(), data.title, data.author);
    } else {
      stopTimer();
      emitTime();
    }
    if (h.onState) h.onState(s === PLAYING ? 'playing' : s === BUFFERING ? 'buffering' : 'paused');
    if (s === ENDED) onEnded();
  }

  function onEnded() {
    if (repeat === 'one') {
      yt.seekTo(0, true);
      yt.playVideo();
      return;
    }
    next({ auto: true });
  }

  function onError(code) {
    if (h.onError) h.onError(current(), code);
    // Si hay más canciones, saltamos a la siguiente tras un momento
    if (index < queue.length - 1 || repeat === 'all') setTimeout(() => next({ auto: true }), 1500);
  }

  // ---------- Acciones ----------
  function current() {
    return queue[index] ?? null;
  }

  function load(i, { autoplay = true, start = 0, restored = false } = {}) {
    if (i < 0 || i >= queue.length) return;
    index = i;
    const videoId = queue[i];
    if (autoplay) yt.loadVideoById({ videoId, startSeconds: start });
    else yt.cueVideoById({ videoId, startSeconds: start });
    if (h.onTrack) h.onTrack(videoId, { restored });
    if (h.onQueue) h.onQueue();
    if (!autoplay) setTimeout(emitTime, 800);
  }

  function next({ auto = false } = {}) {
    if (!queue.length) return;
    if (index < queue.length - 1) load(index + 1);
    else if (repeat === 'all') load(0);
    else if (!auto) yt.seekTo(dur(), true); // al final de la cola: no hay siguiente
  }

  function prev() {
    // Como en cualquier reproductor: si llevas más de 3 s, vuelve al principio
    if (time() > 3 || index <= 0) yt.seekTo(0, true);
    else load(index - 1);
  }

  function playList(ids, start = 0, opts = {}) {
    if (!ids.length) return;
    context = opts.context || '';
    original = [...ids];
    if (shuffle) {
      const first = ids[start];
      queue = [first, ...shuffled(ids.filter((_, i) => i !== start))];
      load(0);
    } else {
      queue = [...ids];
      load(start);
    }
  }

  const single = (id) => playList([id], 0, { context: 'Canción suelta' });

  return {
    current,
    getQueue: () => ({ queue: [...queue], index, context }),
    snapshot: () => ({ queue, original, index, context, time: time() }),
    getRepeat: () => repeat,
    getShuffle: () => shuffle,

    playList,
    next: () => next(),
    prev,
    jump: (i) => load(i),
    play: () => { if (index >= 0) yt.playVideo(); },
    pause: () => yt.pauseVideo(),
    toggle() {
      const s = yt.getPlayerState();
      if (s === PLAYING || s === BUFFERING) yt.pauseVideo();
      else if (index >= 0) yt.playVideo();
    },
    seek(sec) { yt.seekTo(Math.max(0, sec), true); emitTime(); },
    seekBy(delta) { yt.seekTo(Math.max(0, time() + delta), true); emitTime(); },

    playNext(id) {
      if (index < 0) return single(id);
      queue.splice(index + 1, 0, id);
      original.splice(original.indexOf(current()) + 1, 0, id);
      if (h.onQueue) h.onQueue();
    },
    addToQueue(id) {
      if (index < 0) return single(id);
      queue.push(id);
      original.push(id);
      if (h.onQueue) h.onQueue();
    },
    removeAt(i) {
      if (i === index || i < 0 || i >= queue.length) return;
      const [id] = queue.splice(i, 1);
      const o = original.indexOf(id);
      if (o >= 0) original.splice(o, 1);
      if (i < index) index--;
      if (h.onQueue) h.onQueue();
    },

    setVolume(v) { yt.setVolume(v); if (v > 0 && yt.isMuted()) yt.unMute(); },
    setMuted(m) { if (m) yt.mute(); else yt.unMute(); },
    setRepeat(r) { repeat = r; },
    setShuffle(on) {
      if (on === shuffle) return;
      shuffle = on;
      if (index < 0) return;
      const cur = current();
      if (on) {
        queue = [cur, ...shuffled(queue.filter((_, i) => i !== index))];
        index = 0;
      } else {
        const o = original.indexOf(cur);
        if (o >= 0) { queue = [...original]; index = o; }
      }
      if (h.onQueue) h.onQueue();
    },

    /** Recupera la cola guardada, sin empezar a sonar. */
    restore(session) {
      if (!session || !Array.isArray(session.queue) || !session.queue.length) return;
      queue = [...session.queue];
      original = Array.isArray(session.original) && session.original.length ? [...session.original] : [...queue];
      context = session.context || '';
      const i = Math.min(Math.max(Number(session.index) || 0, 0), queue.length - 1);
      load(i, { autoplay: false, start: Math.floor(session.time || 0), restored: true });
    },
  };
}
