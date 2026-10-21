// player.js — El motor de reproducción.
// Lleva la cola propia, el aleatorio, repetir y pasar a la siguiente canción sola.
// No sabe nada de la interfaz: solo avisa de lo que pasa mediante "handlers"
// (funciones que app.js le entrega para que las llame en cada evento).
//
// Quién hace sonar la música lo decide un "backend" (motor intercambiable):
//  - En el navegador: el reproductor oficial de YouTube (iframe).
//  - Dentro de la app Android: el reproductor nativo (window.KRZNative), sin anuncios
//    y que sigue sonando con la pantalla bloqueada.
// Los dos ofrecen las mismas funciones (load, play, pause, seek…), así el resto
// del código no necesita saber cuál está usando.

import { loadYouTubeAPI } from './youtube.js';

/** ¿Estamos dentro de la app Android con el motor nativo? */
export const isNative = () => !!(window.KRZNative && typeof window.KRZNative.play === 'function');

function shuffled(arr) {
  // Algoritmo de Fisher-Yates: baraja de forma justa
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ================================================================
// Motor 1: reproductor de YouTube (navegador)
// ================================================================
async function youtubeBackend(elementId, settings, ev) {
  const YT = await loadYouTubeAPI();
  const ENDED = 0, PLAYING = 1, BUFFERING = 3; // estados que devuelve YouTube
  let yt = null;
  let timer = null;

  const time = () => (yt.getCurrentTime && yt.getCurrentTime()) || 0;
  const dur = () => (yt.getDuration && yt.getDuration()) || 0;
  const emitTime = () => ev.time(time(), dur());
  const stopTimer = () => { clearInterval(timer); timer = null; };
  const startTimer = () => { stopTimer(); timer = setInterval(emitTime, 250); };

  function onState(s) {
    if (s === PLAYING) {
      startTimer();
      const data = yt.getVideoData && yt.getVideoData();
      if (data && data.title) ev.meta(data.title, data.author);
    } else {
      stopTimer();
      emitTime();
    }
    ev.state(s === PLAYING ? 'playing' : s === BUFFERING ? 'buffering' : 'paused');
    if (s === ENDED) ev.ended();
  }

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
        onError: (e) => ev.error(e.data),
      },
    });
  });

  yt.setVolume(settings.volume ?? 80);
  if (settings.muted) yt.mute();

  return {
    native: false,
    load(videoId, { autoplay, start }) {
      if (autoplay) yt.loadVideoById({ videoId, startSeconds: start });
      else { yt.cueVideoById({ videoId, startSeconds: start }); setTimeout(emitTime, 800); }
    },
    play: () => yt.playVideo(),
    pause: () => yt.pauseVideo(),
    isActive() { const s = yt.getPlayerState(); return s === PLAYING || s === BUFFERING; },
    seek(sec) { yt.seekTo(Math.max(0, sec), true); emitTime(); },
    time,
    dur,
    setVolume(v) { yt.setVolume(v); if (v > 0 && yt.isMuted()) yt.unMute(); },
    setMuted(m) { if (m) yt.mute(); else yt.unMute(); },
    setRepeatOne() {},   // YouTube no lo sabe hacer: lo gestiona la cola (más abajo)
    setUpcoming() {},    // no hace falta: aquí la web nunca se duerme con la música sonando
    live: () => null,
  };
}

// ================================================================
// Motor 2: reproductor nativo de la app Android
// ================================================================
function nativeBackend(settings, ev) {
  const N = window.KRZNative;
  let t = 0, d = 0;
  let state = 'paused';
  let pending = null;                 // canción "en espera" (recuperada al abrir, sin sonar aún)
  let volume = settings.volume ?? 80;
  let muted = !!settings.muted;

  // Android nos avisa llamando a esta función (ver MainActivity.kt)
  window.__krzNative = (type, data = {}) => {
    switch (type) {
      case 'state':
        state = data.state === 'ended' ? 'paused' : data.state;
        ev.state(state);
        break;
      case 'time': t = data.t; d = data.d; ev.time(t, d); break;
      case 'ended': ev.ended(); break;
      case 'advanced': t = 0; d = 0; ev.advanced(data.id); break;
      case 'error': ev.error('native'); break;
      case 'next': ev.next(); break;       // botón de la notificación sin siguiente preparada
      case 'prev': ev.prev(); break;
      default: break;
    }
  };

  const applyVolume = () => N.setVolume(muted ? 0 : volume);
  applyVolume();

  return {
    native: true,
    load(id, { autoplay, start, describe }) {
      t = start || 0; d = 0;
      if (!autoplay) {
        // No lo mandamos a Android hasta que pulses play: así no aparece la notificación al abrir
        pending = { id, start: t };
        ev.time(t, d);
        return;
      }
      pending = null;
      N.play(JSON.stringify({ ...describe(id), id, start: t, autoplay: true }));
    },
    play(describe) {
      if (pending) {
        const p = pending;
        pending = null;
        N.play(JSON.stringify({ ...describe(p.id), id: p.id, start: p.start, autoplay: true }));
      } else N.resume();
    },
    pause: () => N.pause(),
    isActive: () => state === 'playing' || state === 'buffering',
    seek(sec) {
      t = Math.max(0, sec);
      if (pending) pending.start = t; else N.seek(t);
      ev.time(t, d);
    },
    time: () => t,
    dur: () => d,
    setVolume(v) { volume = v; if (v > 0) muted = false; applyVolume(); },
    setMuted(m) { muted = m; applyVolume(); },
    setRepeatOne: (on) => N.setRepeatOne(!!on),
    setUpcoming: (list) => N.setUpcoming(JSON.stringify(list)),
    /** Lo que está sonando ahora mismo en Android (si reabres la app con música). */
    live() {
      try {
        const s = JSON.parse(N.state() || '{}');
        if (s.id) { t = s.t || 0; d = s.d || 0; state = s.playing ? 'playing' : 'paused'; }
        return s.id ? s : null;
      } catch { return null; }
    },
  };
}

// ================================================================
// La cola (igual para los dos motores)
// ================================================================
export async function createPlayer(elementId, handlers = {}, settings = {}) {
  const h = handlers;
  const describe = (id) => (h.describe ? h.describe(id) : {});

  let queue = [];         // orden en que van a sonar
  let original = [];      // orden original (para poder quitar el aleatorio)
  let index = -1;         // posición de la canción actual dentro de queue
  let context = '';       // de dónde viene la cola ("Me gusta", nombre de playlist…)
  let repeat = settings.repeat || 'off'; // 'off' | 'all' | 'one'
  let shuffle = !!settings.shuffle;

  // Eventos que nos manda el motor
  const ev = {
    state: (s) => h.onState && h.onState(s),
    time: (cur, total) => h.onTime && h.onTime(cur, total),
    meta: (title, author) => h.onMeta && h.onMeta(current(), title, author),
    ended: () => onEnded(),
    error: (code) => onError(code),
    advanced: (id) => onAdvanced(id),
    next: () => next(),
    prev: () => prev(),
  };

  const be = isNative() ? nativeBackend(settings, ev) : await youtubeBackend(elementId, settings, ev);
  be.setRepeatOne(repeat === 'one');

  // ---------- Eventos internos ----------
  function onEnded() {
    if (repeat === 'one') {
      be.seek(0);
      be.play(describe);
      return;
    }
    next({ auto: true });
  }

  function onError(code) {
    if (h.onError) h.onError(current(), code);
    // Si hay más canciones, saltamos a la siguiente tras un momento
    if (index < queue.length - 1 || repeat === 'all') setTimeout(() => next({ auto: true }), 1500);
  }

  /** El motor nativo ha pasado él solo a la siguiente canción: actualizamos la cola. */
  function onAdvanced(id) {
    let i;
    if (queue[index + 1] === id) i = index + 1;
    else if (repeat === 'all' && queue[0] === id) i = 0;
    else i = queue.indexOf(id);
    if (i < 0) { queue.splice(index + 1, 0, id); i = index + 1; }
    index = i;
    if (h.onTrack) h.onTrack(id, { restored: false });
    if (h.onQueue) h.onQueue();
    syncUpcoming();
  }

  /**
   * Le pasamos al motor nativo las próximas canciones (con aleatorio y repetir ya aplicados),
   * para que pueda seguir solo si la pantalla está bloqueada.
   */
  function syncUpcoming() {
    if (!be.native || index < 0) return;
    let ids = [];
    if (repeat !== 'one') {
      ids = queue.slice(index + 1);
      if (repeat === 'all') ids = ids.concat(queue.slice(0, index + 1));
    }
    be.setUpcoming(ids.slice(0, 30).map((id) => ({ ...describe(id), id })));
  }

  // ---------- Acciones ----------
  function current() {
    return queue[index] ?? null;
  }

  function load(i, { autoplay = true, start = 0, restored = false } = {}) {
    if (i < 0 || i >= queue.length) return;
    index = i;
    const videoId = queue[i];
    be.load(videoId, { autoplay, start, describe });
    if (h.onTrack) h.onTrack(videoId, { restored });
    if (h.onQueue) h.onQueue();
    syncUpcoming();
  }

  function next({ auto = false } = {}) {
    if (!queue.length) return;
    if (index < queue.length - 1) load(index + 1);
    else if (repeat === 'all') load(0);
    else if (!auto && !be.native) be.seek(be.dur()); // al final de la cola: no hay siguiente
  }

  function prev() {
    // Como en cualquier reproductor: si llevas más de 3 s, vuelve al principio
    if (be.time() > 3 || index <= 0) be.seek(0);
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
  const queueChanged = () => { if (h.onQueue) h.onQueue(); syncUpcoming(); };

  return {
    native: be.native,
    current,
    getQueue: () => ({ queue: [...queue], index, context }),
    snapshot: () => ({ queue, original, index, context, time: be.time() }),
    getRepeat: () => repeat,
    getShuffle: () => shuffle,

    playList,
    next: () => next(),
    prev,
    jump: (i) => load(i),
    play: () => { if (index >= 0) be.play(describe); },
    pause: () => be.pause(),
    toggle() {
      if (be.isActive()) be.pause();
      else if (index >= 0) be.play(describe);
    },
    seek(sec) { be.seek(Math.max(0, sec)); },
    seekBy(delta) { be.seek(Math.max(0, be.time() + delta)); },

    playNext(id) {
      if (index < 0) return single(id);
      queue.splice(index + 1, 0, id);
      original.splice(original.indexOf(current()) + 1, 0, id);
      queueChanged();
    },
    addToQueue(id) {
      if (index < 0) return single(id);
      queue.push(id);
      original.push(id);
      queueChanged();
    },
    removeAt(i) {
      if (i === index || i < 0 || i >= queue.length) return;
      const [id] = queue.splice(i, 1);
      const o = original.indexOf(id);
      if (o >= 0) original.splice(o, 1);
      if (i < index) index--;
      queueChanged();
    },

    setVolume: (v) => be.setVolume(v),
    setMuted: (m) => be.setMuted(m),
    setRepeat(r) {
      repeat = r;
      be.setRepeatOne(r === 'one');
      syncUpcoming();
    },
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
      queueChanged();
    },

    /** Recupera la cola guardada, sin empezar a sonar. */
    restore(session) {
      if (!session || !Array.isArray(session.queue) || !session.queue.length) return;
      queue = [...session.queue];
      original = Array.isArray(session.original) && session.original.length ? [...session.original] : [...queue];
      context = session.context || '';

      // Si la app Android ya estaba sonando (la cerraste y la vuelves a abrir), nos enganchamos
      const live = be.live();
      const liveIndex = live ? queue.indexOf(live.id) : -1;
      if (liveIndex >= 0) {
        index = liveIndex;
        if (h.onTrack) h.onTrack(live.id, { restored: true });
        if (h.onQueue) h.onQueue();
        ev.state(live.playing ? 'playing' : 'paused');
        ev.time(live.t || 0, live.d || 0);
        syncUpcoming();
        return;
      }

      const i = Math.min(Math.max(Number(session.index) || 0, 0), queue.length - 1);
      load(i, { autoplay: false, start: Math.floor(session.time || 0), restored: true });
    },
  };
}
