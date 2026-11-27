// Small DOM / timing helpers shared by every screen.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function html(strings, ...vals) {
  const t = document.createElement('template');
  t.innerHTML = strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ''), '').trim();
  return t.content.firstElementChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Toast message at the bottom of the screen. type: info | warn | error | ok */
export function toast(msg, type = 'info', ms = 4000) {
  const box = $('#toasts');
  const el = html`<div class="toast toast-${type}">${esc(msg)}</div>`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('opacity-0'), ms - 300);
  setTimeout(() => el.remove(), ms);
}

/** Big 3-2-1 countdown inside `el`, with a beep per number (audible from 2 m away). */
export async function countdown(el, n = 3) {
  for (let i = n; i > 0; i--) {
    el.textContent = i;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    beep(660, 0.12);
    await sleep(1000);
  }
  el.textContent = 'GO';
  beep(990, 0.25);
}

let actx;
export function beep(freq = 880, dur = 0.15, vol = 0.15) {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.value = vol;
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch { /* audio is a nice-to-have */ }
}

// ---- tiny stats helpers (used by every test) ----
export const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
export const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
