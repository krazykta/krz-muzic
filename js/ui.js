// ui.js — Piezas de interfaz reutilizables: utilidades de texto, avisos (toasts),
// menús contextuales y diálogos. No saben nada de música: cualquier app podría usarlas.

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Escapar texto: convierte < > & " ' en entidades para que un título raro
// no pueda inyectar HTML en la página (protección básica contra XSS).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const thumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const setP = (el, pct) => el.style.setProperty('--p', `${pct}%`);

export function fmt(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
export const clock = (sec) => fmt(sec) || '0:00';

/** Espera a que dejes de llamar a fn durante `ms` milisegundos y entonces la ejecuta. */
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Avisos ----------
export function toast(msg, actions = [], ms = 5000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${actions.map((a, i) => `<button data-i="${i}">${esc(a.label)}</button>`).join('')}`;
  t.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    t.remove();
    actions[b.dataset.i].run();
  });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- Menú contextual (⋮) ----------
let menuCleanup = null;
export function openMenu(anchor, rawItems) {
  closeMenu();
  const items = rawItems.filter(Boolean);
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => `
    <button class="menu-item${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  m.hidden = false;

  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  const left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;

  m.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeMenu();
    items[b.dataset.i].run();
  };
  const onDown = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
  });
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
  };
  m.querySelector('button')?.focus();
}
export function closeMenu() {
  const m = $('#menu');
  if (m) m.hidden = true;
  if (menuCleanup) menuCleanup();
  menuCleanup = null;
}

// ---------- Diálogos ----------
/**
 * Diálogo genérico. Devuelve una Promesa (un valor "que llegará más tarde"):
 * el value del botón pulsado, { action, value } si tiene campo de texto, o null si cancelas.
 */
export function dialog({ title, body = '', input = null, actions = [], dismissable = true }) {
  const dlg = $('#dialog');
  if (dlg.open) dlg.close();
  return new Promise((resolve) => {
    dlg.innerHTML = `
      <form method="dialog" class="dlg">
        <h2 class="dlg-title">${esc(title)}</h2>
        ${body ? `<div class="dlg-body">${body}</div>` : ''}
        ${input ? `<label class="field"><span>${esc(input.label)}</span><input name="text" value="${esc(input.value || '')}" maxlength="80" required autocomplete="off"></label>` : ''}
        ${actions.length ? `<div class="dlg-actions">${actions.map((a) => (a.value === 'cancel'
          ? `<button type="button" class="btn btn-ghost" data-close>${esc(a.label)}</button>`
          : `<button value="${esc(a.value)}" class="btn ${a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-ghost'}">${esc(a.label)}</button>`)).join('')}</div>` : ''}
      </form>`;
    const form = $('form', dlg);
    const field = input ? form.elements.namedItem('text') : null;
    // El botón de cancelar es type="button" para que Intro nunca lo active por error
    $$('[data-close]', dlg).forEach((b) => { b.onclick = () => dlg.close(''); });
    dlg.oncancel = (e) => { if (!dismissable) e.preventDefault(); };
    dlg.onclose = () => {
      const v = dlg.returnValue;
      dlg.onclose = null;
      if (!v || v === 'cancel') return resolve(null);
      return resolve(field ? { action: v, value: field.value.trim() } : v);
    };
    dlg.returnValue = '';
    dlg.showModal();
    if (field) { field.focus(); field.select(); }
  });
}
export const closeDialog = () => { const d = $('#dialog'); if (d.open) d.close(''); };

export async function confirmDialog({ title, body, confirm, danger = false }) {
  const v = await dialog({
    title,
    body: `<p>${esc(body)}</p>`,
    actions: [{ value: 'cancel', label: 'Cancelar' }, { value: 'ok', label: confirm, primary: !danger, danger }],
  });
  return v === 'ok';
}

export const info = (title, text) => dialog({ title, body: `<p>${esc(text)}</p>`, actions: [{ value: 'ok', label: 'Entendido', primary: true }] });
