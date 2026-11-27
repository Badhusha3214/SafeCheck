// SafeCheck flow controller: Start -> Reaction -> Eyes -> Balance -> Speech -> Results.
// Each test module exports run(root, ctx) -> Promise<metrics>. Modules are imported lazily,
// so a problem in one test (e.g. missing camera models) never breaks the others.
import { $, $$, html, esc, toast } from './ui.js';

export const TESTS = [
  {
    id: 'reaction', title: 'Reaction time', module: './reaction.js', fn: 'runReaction',
    steps: [
      'Sit comfortably in front of the laptop.',
      'A red panel will appear. Wait — do <b>not</b> press anything yet.',
      'When it turns <b class="text-emerald-300">GREEN</b>, press <kbd>SPACE</kbd> (or tap) as fast as you can.',
      'There are 5 rounds. Pressing early counts as a false start.',
    ],
    summary: (m) => [['Mean', `${m.mean_ms} ms`], ['Median', `${m.median_ms} ms`], ['Variability', `±${m.sd_ms} ms`], ['False starts', m.false_starts]],
  },
  {
    id: 'eyes', title: 'Eye tracking', module: './eyes.js', fn: 'runEyes',
    steps: [
      'Sit about an arm\'s length from the screen, face well lit.',
      'Keep your <b>head still</b> — move only your eyes.',
      'First, look at 5 dots for calibration (5 seconds).',
      'Then follow the moving dot with your eyes for 15 seconds.',
    ],
    summary: (m) => [['Gaze error', m.tracking_error], ['Correlation', m.correlation], ['Lag', `${m.lag_ms} ms`], ['Saccades', `${m.saccades_per_s}/s`]],
  },
  {
    id: 'balance', title: 'One-leg balance', module: './balance.js', fn: 'runBalance',
    steps: [
      'Step back about <b>2 metres</b> so your whole body (head to feet) is visible.',
      'Arms relaxed at your sides, look at the screen.',
      'After the countdown, raise one foot about 15 cm off the floor.',
      'Hold for 15 seconds. Put the foot down only if you must.',
    ],
    summary: (m) => [['Sway', m.sway_amplitude], ['Sway speed', `${m.sway_velocity}/s`], ['Touch-downs', m.touchdowns]],
  },
  {
    id: 'speech', title: 'Speech', module: './speech.js', fn: 'runSpeech',
    steps: [
      'Read the sentence on the next screen aloud, at your normal pace.',
      'Speak clearly, about 50 cm from the laptop.',
      'Recording stops automatically, or press <b>Stop</b> when done.',
    ],
    summary: (m) => [['Rate', `${m.wpm} wpm`], ['Pauses', m.pause_count], ['Word error', `${Math.round(m.wer * 100)}%`]],
  },
];

const state = { subject: null, mode: 'screening', lang: 'en', metrics: {}, config: null, demo: null };
export const ctx = { video: () => $('#cam'), state };

// ------------------------------------------------------------------ navigation
function show(screenId, step) {
  $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== screenId));
  const order = ['start', ...TESTS.map((t) => t.id), 'results'];
  $$('#stepper li').forEach((li) => {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(step);
    li.classList.toggle('active', i === cur);
    li.classList.toggle('done', i < cur);
  });
  window.scrollTo(0, 0);
}

async function loadConfig() {
  try {
    const r = await fetch(`/api/config?lang=${state.lang}`);
    state.config = await r.json();
  } catch {
    toast('Backend not reachable — is `python run.py` running?', 'error', 8000);
  }
}

// ------------------------------------------------------------------ start screen
function initStart() {
  const consent = $('#consent'), btn = $('#start-btn');
  consent.addEventListener('change', () => (btn.disabled = !consent.checked));
  $('#baseline').addEventListener('change', (e) => $('#mode-badge').classList.toggle('hidden', !e.target.checked));
  if (new URLSearchParams(location.search).get('mode') === 'baseline') {
    $('#baseline').checked = true; $('#mode-badge').classList.remove('hidden');
  }
  $('#start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!consent.checked) return;
    state.subject = $('#subject').value.trim() || null;
    state.lang = $('#lang').value;
    state.mode = $('#baseline').checked ? 'baseline' : 'screening';
    state.metrics = {};
    state.demo = null;
    loadConfig().then(() => runTest(0));
  });
  $('#demo-btn').addEventListener('click', async () => {
    const { startDemo } = await import('./demo.js');
    state.subject = 'Demo'; state.lang = $('#lang').value;
    startDemo(state, { show, TESTS, finish: showResults });
  });
}

// ------------------------------------------------------------------ test screens
async function runTest(i) {
  if (i >= TESTS.length) return showResults();
  const t = TESTS[i];
  show('screen-test', t.id);
  $('#test-step').textContent = `Test ${i + 1} of ${TESTS.length}`;
  $('#test-title').textContent = t.title;
  const body = $('#test-body');
  const skip = $('#skip-btn');
  skip.classList.remove('hidden');
  skip.onclick = () => { state.metrics[t.id] = null; stopActive(); runTest(i + 1); };

  // 1) instructions
  body.innerHTML = '';
  body.appendChild(html`
    <div class="card p-8 md:p-10 grid md:grid-cols-[1fr_auto] gap-8 items-center">
      <ol class="instructions">${t.steps.map((s, n) => `<li data-n="${n + 1}">${s}</li>`).join('')}</ol>
      <button id="go-btn" class="btn btn-primary btn-xl">I'm ready →</button>
    </div>`);
  await new Promise((r) => {
    const go = $('#go-btn');
    go.focus();
    go.onclick = r;
  });

  // 2) run the test
  body.innerHTML = '';
  try {
    const mod = await import(t.module);
    const metrics = await mod[t.fn](body, ctx);
    stopActive();
    if (metrics == null) return; // test was cancelled (skip pressed)
    state.metrics[t.id] = metrics;
    showSummary(i, metrics);
  } catch (err) {
    stopActive();
    console.error(err);
    body.innerHTML = '';
    body.appendChild(html`
      <div class="card p-8 flex flex-col gap-6">
        <div class="banner banner-error">⚠ ${esc(err.message || err)}</div>
        <div class="flex gap-3 flex-wrap">
          <button id="retry" class="btn btn-primary">Retry</button>
          <button id="skip2" class="btn btn-ghost">Skip this test</button>
        </div>
      </div>`);
    $('#retry').onclick = () => runTest(i);
    $('#skip2').onclick = () => { state.metrics[t.id] = null; runTest(i + 1); };
  }
}

/** Lets a running test register a cleanup (stop loops, mic, etc.) for Skip. */
let activeCleanup = null;
export function onCleanup(fn) { activeCleanup = fn; }
function stopActive() { try { activeCleanup?.(); } finally { activeCleanup = null; } }

function showSummary(i, m) {
  const t = TESTS[i], body = $('#test-body');
  $('#skip-btn').classList.add('hidden');
  const lowQ = m.quality != null && m.quality < (state.config?.scoring?.min_quality ?? 0.6);
  body.innerHTML = '';
  body.appendChild(html`
    <div class="card p-8 md:p-10 flex flex-col gap-8">
      <div class="flex items-center gap-4">
        <span class="text-5xl">✅</span>
        <div><h3 class="text-3xl font-extrabold">${t.title} complete</h3>
        <p class="text-slate-400 text-lg">Capture quality: ${Math.round((m.quality ?? 1) * 100)}%</p></div>
      </div>
      ${lowQ ? '<div class="banner banner-warn">⚠ Capture quality was low — this test may be excluded from the result. Consider retrying.</div>' : ''}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        ${t.summary(m).map(([k, v]) => `<div class="mini-card flex-col !items-start"><span class="text-slate-400 text-sm">${k}</span><span class="text-2xl">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="flex gap-3 flex-wrap">
        <button id="next" class="btn btn-primary btn-xl">${i + 1 < TESTS.length ? 'Next test →' : 'See results →'}</button>
        <button id="again" class="btn btn-ghost">↻ Retry this test</button>
      </div>
    </div>`);
  $('#next').focus();
  $('#next').onclick = () => runTest(i + 1);
  $('#again').onclick = () => runTest(i);
}

// ------------------------------------------------------------------ results
async function showResults(precomputed) {
  show('screen-results', 'results');
  const { renderResults } = await import('./results.js');
  renderResults($('#screen-results'), state, precomputed, () => location.reload());
}

initStart();
loadConfig();
