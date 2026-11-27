// Results screen: verdict, radar chart, per-test breakdown with normal ranges.
// Scoring itself happens on the backend (backend/scoring.py) so there is one source of truth.
import { $, html, esc } from './ui.js';

const NAMES = { reaction: 'Reaction', eyes: 'Eye tracking', balance: 'Balance', speech: 'Speech' };
const ICONS = { reaction: '⚡', eyes: '👁', balance: '🧍', speech: '🗣' };
const VERDICT_TEXT = {
  Normal: 'All measures are within the normal range.',
  Borderline: 'Some measures are outside the normal range. Consider a re-test.',
  Flag: 'Several measures are well outside the normal range. Further assessment advised.',
  Incomplete: 'Not enough reliable data to give a result.',
};

const scoreColor = (s) => (s == null ? '#64748b' : s >= 70 ? '#34d399' : s >= 40 ? '#fbbf24' : '#f87171');

function fmt(v, unit) {
  if (typeof v !== 'number') return esc(v);
  if (unit === 'ms' || unit === 'wpm') return `${Math.round(v)} ${unit}`;
  if (unit === 's') return `${v.toFixed(1)} s`;
  if (unit === '' && Number.isInteger(v)) return String(v);
  return `${v.toFixed(Math.abs(v) < 1 ? 3 : 2)}${unit && unit !== 'screen' && unit !== 'torso' ? ' ' + unit : ''}`;
}

/** Normal range = mean ± 2 SD, shown one-sided for metrics where only one direction is bad. */
function rangeText(m) {
  if (m.direction === 'lower_better') return `≤ ${fmt(m.high, m.unit)}`;
  if (m.direction === 'higher_better') return `≥ ${fmt(Math.max(0, m.low), m.unit)}`;
  return `${fmt(m.low, m.unit)} – ${fmt(m.high, m.unit)}`;
}

export async function renderResults(root, state, precomputed, onRestart) {
  root.innerHTML = '<div class="flex items-center gap-4 text-2xl p-10"><div class="spinner"></div>Scoring…</div>';
  let r = precomputed;
  if (!r) {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: state.subject, mode: state.mode, lang: state.lang, metrics: state.metrics, save: !state.demo }),
      });
      r = await res.json();
      if (!res.ok) throw new Error(r.detail || res.status);
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(html`<div class="banner banner-error">⚠ Could not score the session: ${esc(e.message)}. Is the backend running?</div>`);
      return;
    }
  }

  const tests = r.tests;
  const overall = r.overall == null ? '–' : Math.round(r.overall);
  root.innerHTML = '';
  root.appendChild(html`
    <div class="flex flex-col gap-8">
      <div class="verdict verdict-${r.result}">
        <div class="text-center shrink-0">
          <div class="text-7xl font-black c-${r.result}">${overall}</div>
          <div class="text-slate-400 font-semibold">overall / 100</div>
        </div>
        <div class="flex-1">
          <p class="eyebrow">${state.mode === 'baseline' ? 'Baseline session' : 'Screening result'}${state.subject ? ' · ' + esc(state.subject) : ''}</p>
          <h2 class="text-6xl font-black c-${r.result}">${r.result}</h2>
          <p class="text-xl text-slate-300 mt-2">${VERDICT_TEXT[r.result] || ''}</p>
          ${r.id ? `<p class="text-slate-500 mt-1">Session #${r.id} saved${state.mode === 'baseline' ? ' to the baseline set' : ''}.</p>` : state.demo ? '<p class="text-violet-300 mt-1">Demo session — not saved.</p>' : ''}
        </div>
      </div>

      <div class="results-grid">
        <div class="card p-6 flex flex-col min-w-0">
          <h3 class="text-xl font-bold mb-2">Profile</h3>
          <div class="relative flex-1 min-h-[340px]"><canvas id="radar"></canvas></div>
          <p class="text-slate-500 text-sm mt-2">Shaded ring = normal zone (score ≥ 70).</p>
        </div>
        <div id="test-cards" class="cards-grid"></div>
      </div>

      <div id="extras" class="extras-grid"></div>

      <div class="banner banner-warn">⚠ Screening only — not a medical or legal test. Results can be affected by fatigue, illness, medication, injury, language and camera conditions.</div>
      <div class="flex gap-3 flex-wrap">
        <button id="again" class="btn btn-primary btn-xl">New screening</button>
        <a href="/dashboard.html" class="btn btn-ghost btn-xl">Open dashboard</a>
        <button onclick="window.print()" class="btn btn-ghost btn-xl">Print</button>
      </div>
    </div>`);
  $('#again', root).onclick = onRestart;

  // ---- per-test cards
  const cards = $('#test-cards', root);
  for (const [t, v] of Object.entries(tests)) {
    const badge = v.status === 'skipped' ? '<span class="badge badge-violet">SKIPPED</span>'
      : v.status === 'unreliable' ? '<span class="badge badge-amber">LOW QUALITY – EXCLUDED</span>' : '';
    const rows = Object.values(v.metrics || {}).map((m) => `
      <div class="metric-row">
        <span class="text-slate-300">${esc(m.label)}</span>
        <span class="font-bold ${m.in_range ? '' : 'text-red-300'}">${fmt(m.value, m.unit)}</span>
        <span class="text-slate-500 text-sm">normal ${rangeText(m)}${m.source === 'baseline' ? ' · from baseline' : ''}</span>
        <div class="bar self-center w-24"><div style="width:${m.score}%;background:${scoreColor(m.score)}"></div></div>
      </div>`).join('');
    cards.appendChild(html`
      <div class="card p-5 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-xl font-bold">${ICONS[t]} ${NAMES[t]}</h4>
          <span class="text-3xl font-black" style="color:${scoreColor(v.score)}">${v.score == null ? '–' : Math.round(v.score)}</span>
        </div>
        ${badge}
        <div>${rows || '<p class="text-slate-500">No data.</p>'}</div>
      </div>`);
  }

  // ---- radar chart
  if (window.Chart) {
    const labels = Object.keys(tests).map((t) => NAMES[t]);
    const data = Object.values(tests).map((v) => (v.status === 'ok' ? v.score : 0));
    const col = scoreColor(r.overall);
    new Chart($('#radar', root), {
      type: 'radar',
      data: {
        labels,
        datasets: [
          { label: 'Score', data, borderColor: col, backgroundColor: col + '33', borderWidth: 3, pointBackgroundColor: col, pointRadius: 5 },
          { label: 'Normal zone', data: labels.map(() => 70), borderColor: '#34d39955', backgroundColor: '#34d39910', borderDash: [6, 6], pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 14 } } } },
        scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, color: '#64748b', backdropColor: 'transparent' },
          grid: { color: '#24314f' }, angleLines: { color: '#24314f' }, pointLabels: { color: '#e8eefc', font: { size: 16, weight: 'bold' } } } },
      },
    });
  }

  // ---- extras: reasons, eye trace, transcript
  const extras = $('#extras', root);
  if (r.reasons?.length) {
    extras.appendChild(html`<div class="card p-6"><h3 class="text-xl font-bold mb-3">Why this result</h3>
      <ul class="list-disc pl-6 text-lg text-slate-300 space-y-1">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
  }
  const trace = state.metrics?.eyes?.trace;
  if (trace?.length && window.Chart) {
    extras.appendChild(html`<div class="card p-6"><h3 class="text-xl font-bold mb-3">Eye pursuit trace (horizontal)</h3>
      <div class="relative h-56"><canvas id="trace"></canvas></div></div>`);
    new Chart($('#trace', root), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Target', data: trace.map(([t, , x]) => ({ x: t / 1000, y: x })), borderColor: '#64748b', borderWidth: 2, pointRadius: 0 },
          { label: 'Gaze', data: trace.map(([t, g]) => ({ x: t / 1000, y: g })), borderColor: '#22d3ee', borderWidth: 2, pointRadius: 0 },
        ],
      },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { legend: { labels: { color: '#cbd5e1' } } },
        scales: { x: { type: 'linear', title: { display: true, text: 'seconds', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
          y: { min: -0.1, max: 1.1, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } } },
    });
  }
  const sp = state.metrics?.speech;
  if (sp?.transcript != null) {
    extras.appendChild(html`<div class="card p-6"><h3 class="text-xl font-bold mb-3">Speech</h3>
      <p class="text-slate-400">Expected</p><p class="text-lg mb-3">${esc(sp.expected)}</p>
      <p class="text-slate-400">Heard</p><p class="text-lg">${esc(sp.transcript)}</p></div>`);
  }
}
