// DEMO MODE - replays a sample session so the pitch works even without camera/mic.
// Each test plays a short animation driven by the sample's numbers, then the real backend
// scores the sample (not saved), so the results screen is 100 % the production code path.
import { $, html, esc, sleep } from './ui.js';

let cancelled = false;

export async function startDemo(state, { show, TESTS, finish }) {
  const data = await fetch('/api/demo').then((r) => r.json());
  $('#demo-badge').classList.remove('hidden');

  // ---- choose a profile
  show('screen-test', 'start');
  $('#test-step').textContent = 'Demo mode';
  $('#test-title').textContent = 'Choose a sample session';
  $('#skip-btn').classList.add('hidden');
  const body = $('#test-body');
  body.innerHTML = '';
  const chooser = html`<div class="grid md:grid-cols-2 gap-6"></div>`;
  for (const [key, p] of Object.entries(data.profiles)) {
    chooser.appendChild(html`
      <button class="card p-8 text-left hover:border-cyan-400 transition flex flex-col gap-3" data-k="${key}">
        <span class="text-4xl">${key === 'sober' ? '🙂' : '🥴'}</span>
        <span class="text-3xl font-extrabold">${esc(p.label)}</span>
        <span class="text-lg text-slate-400">${esc(p.description)}</span>
      </button>`);
  }
  body.appendChild(chooser);
  const key = await new Promise((r) => chooser.querySelectorAll('button').forEach((b) => (b.onclick = () => r(b.dataset.k))));
  const profile = data.profiles[key];

  state.demo = key;
  state.mode = 'screening';
  state.lang = profile.lang;
  state.subject = `Demo – ${profile.label}`;
  state.metrics = structuredClone(profile.metrics);
  state.metrics.eyes.trace = fakeTrace(profile.metrics.eyes);

  // ---- replay each test
  cancelled = false;
  const skip = $('#skip-btn');
  skip.textContent = 'Skip to results';
  skip.classList.remove('hidden');
  skip.onclick = () => { cancelled = true; };
  for (let i = 0; i < TESTS.length && !cancelled; i++) {
    const t = TESTS[i];
    show('screen-test', t.id);
    $('#test-step').textContent = `Demo · Test ${i + 1} of ${TESTS.length}`;
    $('#test-title').textContent = t.title;
    body.innerHTML = '';
    await ANIM[t.id](body, state.metrics[t.id]);
    if (!cancelled) await sleep(600);
  }
  skip.textContent = 'Skip this test';
  finish();
}

const until = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms && !cancelled) await sleep(50); };

function fakeTrace(m) {
  // gaze = target delayed by lag, plus noise and occasional catch-up jumps
  const out = [];
  let off = 0, seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let t = 0; t < 15000; t += 100) {
    const tgt = (tt) => (tt < 8000 ? 0.5 + 0.38 * Math.sin((2 * Math.PI * tt) / 4000) : 0.5 + 0.17 * Math.cos((2 * Math.PI * (tt - 8000)) / 3500));
    if (rnd() < -0.5 + m.saccades_per_s / 10) off = rnd() * 0.3;
    off *= 0.7;
    out.push([t, +(tgt(Math.max(0, t - m.lag_ms)) + off + rnd() * m.tracking_error).toFixed(3), +tgt(t).toFixed(3)]);
  }
  return out;
}

const ANIM = {
  async reaction(root, m) {
    root.appendChild(html`<div class="flex flex-col items-center gap-6">
      <div id="p" class="rt-panel rt-wait"><div id="msg" class="text-6xl font-bold">Wait…</div></div>
      <div id="chips" class="flex gap-3">${m.trials.map(() => '<div class="chip">–</div>').join('')}</div></div>`);
    const p = $('#p', root), msg = $('#msg', root), chips = $('#chips', root).children;
    for (let i = 0; i < m.trials.length && !cancelled; i++) {
      p.className = 'rt-panel rt-wait'; msg.textContent = 'Wait…';
      await until(450);
      p.className = 'rt-panel rt-go'; msg.textContent = 'NOW!';
      await until(m.trials[i]);
      p.className = 'rt-panel rt-wait'; msg.textContent = `${m.trials[i]} ms`;
      chips[i].textContent = `${m.trials[i]} ms`; chips[i].classList.add('chip-done');
      await until(350);
    }
  },

  async eyes(root, m) {
    root.appendChild(html`<div class="card p-4"><canvas class="w-full rounded-xl" style="height:52vh;background:#05070f"></canvas>
      <div class="flex gap-6 mt-3 text-lg"><span><b style="color:#22d3ee">●</b> target dot</span><span><b style="color:#f472b6">●</b> estimated gaze</span></div></div>`);
    const c = $('canvas', root), g = c.getContext('2d');
    c.width = c.clientWidth * devicePixelRatio; c.height = c.clientHeight * devicePixelRatio;
    const W = c.width, H = c.height, trail = [];
    const t0 = performance.now();
    let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    let off = [0, 0];
    while (!cancelled) {
      const t = (performance.now() - t0) * 2;  // 2x speed replay of the 15 s test
      if (t > 15000) break;
      const pos = (tt) => tt < 8000 ? [0.5 + 0.38 * Math.sin((2 * Math.PI * tt) / 4000), 0.5]
        : [0.5 + 0.17 * Math.cos((2 * Math.PI * (tt - 8000)) / 3500), 0.5 + 0.3 * Math.sin((2 * Math.PI * (tt - 8000)) / 3500)];
      const [tx, ty] = pos(t);
      const [lx, ly] = pos(Math.max(0, t - m.lag_ms));
      if (Math.random() < m.saccades_per_s / 60) off = [rnd() * 0.25, rnd() * 0.15];
      off = off.map((o) => o * 0.9);
      const gx = lx + off[0] + rnd() * m.tracking_error * 0.4, gy = ly + off[1] + rnd() * m.tracking_error * 0.4;
      trail.push([gx, gy]); if (trail.length > 25) trail.shift();
      g.clearRect(0, 0, W, H);
      trail.forEach(([x, y], i) => { g.fillStyle = `rgba(244,114,182,${i / 50})`; g.beginPath(); g.arc(x * W, y * H, 6 * devicePixelRatio, 0, 7); g.fill(); });
      g.shadowColor = '#22d3ee'; g.shadowBlur = 25; g.fillStyle = '#22d3ee';
      g.beginPath(); g.arc(tx * W, ty * H, 14 * devicePixelRatio, 0, 7); g.fill(); g.shadowBlur = 0;
      g.fillStyle = '#f472b6'; g.beginPath(); g.arc(gx * W, gy * H, 9 * devicePixelRatio, 0, 7); g.fill();
      await new Promise(requestAnimationFrame);
    }
  },

  async balance(root, m) {
    root.appendChild(html`<div class="card p-4 grid md:grid-cols-[1fr_auto] gap-6 items-center">
      <canvas class="w-full rounded-xl" style="height:52vh;background:#05070f"></canvas>
      <div class="flex flex-col gap-2 pr-6"><span class="text-slate-400">Touch-downs</span><span id="td" class="text-6xl font-black">0</span></div></div>`);
    const c = $('canvas', root), g = c.getContext('2d');
    c.width = c.clientWidth * devicePixelRatio; c.height = c.clientHeight * devicePixelRatio;
    const W = c.width, H = c.height, u = H / 9;
    const downs = Array.from({ length: m.touchdowns }, (_, i) => ((i + 1) * 7500) / (m.touchdowns + 1));
    const t0 = performance.now();
    let count = 0;
    while (!cancelled) {
      const t = (performance.now() - t0) * 2.5;
      if (t > 15000) break;
      const down = downs.some((d) => t > d && t < d + 600);
      count = downs.filter((d) => t > d).length;
      $('#td', root).textContent = count;
      const sway = m.sway_amplitude * 9 * (Math.sin(t / 380) + 0.4 * Math.sin(t / 157));
      const hip = [W / 2 + sway * u * 3, H - 4.6 * u], sh = [W / 2 + sway * u * 5, H - 7.2 * u];
      g.clearRect(0, 0, W, H);
      g.strokeStyle = '#334155'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, H - 0.6 * u); g.lineTo(W, H - 0.6 * u); g.stroke();
      g.strokeStyle = down ? '#f87171' : '#22d3ee'; g.lineWidth = 10; g.lineCap = 'round';
      const line = (a, b) => { g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); };
      line(sh, hip);
      line(hip, [W / 2 - 0.4 * u, H - 0.6 * u]);                                   // standing leg
      line(hip, down ? [W / 2 + 0.6 * u, H - 0.6 * u] : [W / 2 + 0.7 * u, H - 1.6 * u]);  // raised leg
      line(sh, [sh[0] - 0.9 * u, sh[1] + 2.2 * u]); line(sh, [sh[0] + 0.9 * u, sh[1] + 2.2 * u]);
      g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(sh[0] + sway * u, sh[1] - 0.9 * u, 0.55 * u, 0, 7); g.fill();
      await new Promise(requestAnimationFrame);
    }
  },

  async speech(root, m) {
    const words = m.expected.split(' ');
    root.appendChild(html`<div class="flex flex-col gap-6">
      <div class="card"><p class="eyebrow px-10 pt-8">Read this aloud</p>
        <div class="sentence">${words.map((w) => `<span class="transition-colors">${esc(w)}</span>`).join(' ')}</div></div>
      <div class="card p-6 flex items-center gap-3 text-xl font-bold"><span class="rec-dot"></span>Recording… <span class="text-slate-400 font-normal">${m.wpm} words / min</span></div>
      <div id="heard"></div></div>`);
    const spans = root.querySelectorAll('.sentence span');
    const per = Math.min(400, 60000 / m.wpm / 1.5);
    const pauseAt = new Set(Array.from({ length: m.pause_count }, (_, i) => Math.round(((i + 1) * words.length) / (m.pause_count + 1))));
    for (let i = 0; i < spans.length && !cancelled; i++) {
      spans[i].style.color = '#22d3ee';
      await until(per + (pauseAt.has(i) ? 500 : 0));
    }
    $('#heard', root).innerHTML = `<div class="banner banner-ok">Heard: “${esc(m.transcript)}”</div>`;
    await until(1600);
  },
};
