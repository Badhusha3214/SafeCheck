// Admin dashboard: sessions list, filters, CSV export, summary charts, baseline status.
import { $, html, esc, toast } from './ui.js';

const TESTS = ['reaction', 'eyes', 'balance', 'speech'];
const NAMES = { reaction: 'Reaction', eyes: 'Eyes', balance: 'Balance', speech: 'Speech' };
const RESULT_COLORS = { Normal: '#34d399', Borderline: '#fbbf24', Flag: '#f87171', Incomplete: '#64748b' };
const charts = {};

if (window.Chart) {
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = '#24314f';
  Chart.defaults.font.family = 'Segoe UI, system-ui, sans-serif';
}

const scoreCell = (s) => (s == null ? '<span class="text-slate-600">–</span>'
  : `<span style="color:${s >= 70 ? '#34d399' : s >= 40 ? '#fbbf24' : '#f87171'}" class="font-bold">${Math.round(s)}</span>`);

function params() {
  const fd = new FormData($('#filters'));
  const p = new URLSearchParams();
  for (const [k, v] of fd) if (v) p.set(k, v);
  return p;
}

async function load() {
  const p = params();
  $('#csv').href = `/api/export.csv?${p}`;
  let sessions;
  try {
    sessions = await fetch(`/api/sessions?${p}`).then((r) => r.json());
  } catch {
    toast('Backend not reachable', 'error');
    return;
  }
  renderTiles(sessions);
  renderTable(sessions);
  renderCharts(sessions);
}

function renderTiles(all) {
  const screening = all.filter((s) => s.mode === 'screening');
  const flagged = screening.filter((s) => s.result === 'Flag').length;
  const scored = all.filter((s) => s.overall_score != null);
  const avg = scored.length ? scored.reduce((a, s) => a + s.overall_score, 0) / scored.length : null;
  const tile = (label, value, sub = '') => `<div class="card p-5"><div class="text-slate-400 font-semibold">${label}</div>
    <div class="text-4xl font-black mt-1">${value}</div><div class="text-slate-500 text-sm mt-1">${sub}</div></div>`;
  $('#tiles').innerHTML =
    tile('Sessions', all.length, 'matching filters') +
    tile('Screenings', screening.length, `${all.length - screening.length} baseline`) +
    tile('Flagged', screening.length ? `${Math.round((flagged / screening.length) * 100)}%` : '–', `${flagged} of ${screening.length} screenings`) +
    tile('Avg. overall score', avg == null ? '–' : Math.round(avg), 'all scored sessions');
}

function renderTable(sessions) {
  $('#count').textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  const tbody = $('#rows');
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="text-center text-slate-500 !py-10">No sessions yet — run a screening or a baseline session.</td></tr>';
    return;
  }
  tbody.innerHTML = sessions.map((s) => {
    const t = s.scores?.tests || {};
    return `<tr data-id="${s.id}">
      <td class="text-slate-500">${s.id}</td>
      <td>${new Date(s.created_at).toLocaleString()}</td>
      <td class="font-semibold">${esc(s.subject || 'Anonymous')}</td>
      <td>${s.mode === 'baseline' ? '<span class="badge badge-amber">BASELINE</span>' : 'Screening'}</td>
      <td>${esc(s.lang || '')}</td>
      <td>${scoreCell(s.overall_score)}</td>
      <td><span class="pill pill-${esc(s.result)}">${esc(s.result)}</span></td>
      ${TESTS.map((k) => `<td>${scoreCell(t[k]?.score)}</td>`).join('')}
      <td class="whitespace-nowrap"><button class="btn btn-ghost btn-sm" data-act="view">View</button>
        <button class="btn btn-ghost btn-sm" data-act="del">Delete</button></td></tr>`;
  }).join('');
}

// Delete uses a two-click inline confirm (no browser dialogs — they block kiosk/projector setups).
$('#rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  if (btn.dataset.act === 'view') return showDetail(id);
  if (btn.dataset.act === 'del') {
    if (btn.dataset.armed) {
      const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (r.ok) { toast(`Session #${id} deleted`, 'ok'); load(); loadNorms(); } else toast('Delete failed', 'error');
    } else {
      btn.dataset.armed = '1'; btn.textContent = 'Confirm?'; btn.classList.add('btn-danger');
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Delete'; btn.classList.remove('btn-danger'); } }, 3000);
    }
  }
});

async function showDetail(id) {
  const s = await fetch(`/api/sessions/${id}`).then((r) => r.json());
  const box = $('#detail');
  const tests = s.scores?.tests || {};
  box.innerHTML = '';
  box.appendChild(html`
    <div class="card p-7 max-w-3xl w-full max-h-[85vh] overflow-auto flex flex-col gap-4">
      <div class="flex justify-between items-start gap-4">
        <div><p class="eyebrow">Session #${s.id} · ${new Date(s.created_at).toLocaleString()}</p>
          <h3 class="text-3xl font-extrabold">${esc(s.subject || 'Anonymous')} — <span class="c-${esc(s.result)}">${esc(s.result)}</span> ${s.overall_score == null ? '' : Math.round(s.overall_score)}</h3></div>
        <button class="btn btn-ghost btn-sm" id="close">✕ Close</button>
      </div>
      ${(s.scores?.reasons || []).length ? `<ul class="list-disc pl-6 text-slate-300">${s.scores.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="grid sm:grid-cols-2 gap-4">
        ${TESTS.map((k) => `<div class="mini-card flex-col !items-stretch">
          <div class="flex justify-between"><span>${NAMES[k]}</span>${scoreCell(tests[k]?.score)}</div>
          ${Object.values(tests[k]?.metrics || {}).map((m) => `<div class="flex justify-between text-sm font-normal text-slate-400"><span>${esc(m.label)}</span><span class="${m.in_range ? '' : 'text-red-300'}">${typeof m.value === 'number' ? +m.value.toFixed(3) : esc(m.value)} ${esc(m.unit)}</span></div>`).join('')}
          ${tests[k]?.status && tests[k].status !== 'ok' ? `<span class="text-sm text-amber-300">${esc(tests[k].status)}</span>` : ''}
        </div>`).join('')}
      </div>
      ${s.metrics?.speech?.transcript ? `<div class="text-slate-400">Speech heard: <span class="text-slate-200">“${esc(s.metrics.speech.transcript)}”</span></div>` : ''}
    </div>`);
  box.classList.remove('hidden');
  const close = () => box.classList.add('hidden');
  $('#close', box).onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
}

function renderCharts(sessions) {
  if (!window.Chart) return;
  const mk = (id, cfg) => { charts[id]?.destroy(); charts[id] = new Chart($(id), cfg); };
  const counts = Object.keys(RESULT_COLORS).map((r) => sessions.filter((s) => s.result === r).length);

  mk('#c-results', {
    type: 'doughnut',
    data: { labels: Object.keys(RESULT_COLORS), datasets: [{ data: counts, backgroundColor: Object.values(RESULT_COLORS), borderColor: '#111a2e', borderWidth: 3 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right' } } },
  });

  const avg = TESTS.map((k) => {
    const v = sessions.map((s) => s.scores?.tests?.[k]).filter((t) => t?.status === 'ok').map((t) => t.score);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  mk('#c-tests', {
    type: 'bar',
    data: { labels: TESTS.map((k) => NAMES[k]), datasets: [{ label: 'Average score', data: avg, borderRadius: 6, maxBarThickness: 48,
      backgroundColor: avg.map((s) => (s == null ? '#334155' : s >= 70 ? '#34d399' : s >= 40 ? '#fbbf24' : '#f87171')) }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } },
  });

  const chron = [...sessions].reverse().filter((s) => s.overall_score != null);
  mk('#c-time', {
    type: 'line',
    data: { labels: chron.map((s) => `#${s.id}`), datasets: [{ label: 'Overall', data: chron.map((s) => s.overall_score),
      borderColor: '#22d3ee', backgroundColor: '#22d3ee22', fill: true, tension: 0.3,
      pointBackgroundColor: chron.map((s) => RESULT_COLORS[s.result]), pointRadius: 5 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } },
  });
}

async function loadNorms() {
  const lang = $('#norm-lang').value;
  const b = await fetch(`/api/baseline?lang=${lang}`).then((r) => r.json());
  const learned = Object.values(b.norms).flatMap((t) => Object.values(t)).filter((n) => n.source === 'baseline').length;
  $('#baseline-status').innerHTML = b.count >= b.min_sessions
    ? `<span class="text-emerald-300 font-semibold">Baseline active</span> — ${b.count} volunteer sessions; ${learned} metrics use learned ranges.`
    : `${b.count} / ${b.min_sessions} baseline sessions collected. Default ranges from <code>config/config.json</code> are used until ${b.min_sessions} exist.`;
  const f = (x) => (Math.abs(x) < 1 ? +x.toFixed(3) : +x.toFixed(1));
  $('#norms').innerHTML = Object.entries(b.norms).flatMap(([t, ms]) => Object.values(ms).map((n) => `<tr>
    <td>${NAMES[t]}</td><td>${esc(n.label)}</td><td>${f(n.mean)} ${esc(n.unit)}</td><td>${f(n.sd)}</td>
    <td>${n.direction === 'lower_better' ? `≤ ${f(n.high)}` : n.direction === 'higher_better' ? `≥ ${f(Math.max(0, n.low))}` : `${f(n.low)} – ${f(n.high)}`} ${esc(n.unit)}</td>
    <td>${n.source === 'baseline' ? '<span class="pill pill-Normal">baseline</span>' : '<span class="pill pill-Incomplete">default</span>'}</td><td>${n.n}</td></tr>`)).join('');
}

$('#filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
$('#filters').addEventListener('reset', () => setTimeout(load, 0));
$('#norm-lang').addEventListener('change', loadNorms);
load();
loadNorms();
