// TEST 3 - One-leg stand (inspired by the field sobriety One-Leg-Stand test).
//
// MediaPipe Pose gives 33 body landmarks per frame. We use:
//   shoulders 11/12, hips 23/24, ankles 27/28.
// Everything is measured in TORSO LENGTHS (shoulder-centre to hip-centre distance), so the
// numbers do not depend on how far the person stands from the camera.
//
// Metrics
//   sway_amplitude  RMS distance of the body centre (mid-point of shoulders+hips) from its mean
//   sway_velocity   average speed of the body centre (path length / time)
//   touchdowns      times the raised foot comes back down to the floor level of the standing foot
import { $, html, sleep, countdown, mean, round, beep } from './ui.js';
import { startCamera, getPoseLandmarker, brightness, lightingMessage, videoTs, cameraPicker } from './camera.js';
import { onCleanup } from './app.js';

const DURATION_MS = 15000;
const VIS = 0.5;               // landmark visibility needed to trust it
const LIFTED = 0.10;           // raised-ankle height above standing ankle (torso lengths) = "foot up"
const DOWN = 0.04;             // below this = foot on the floor
const DOWN_MIN_MS = 150;       // must stay down this long to count (filters jitter)
const KEY = [11, 12, 23, 24, 27, 28];
const SKELETON = [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [11, 13], [13, 15], [12, 14], [14, 16]];

/** Pixel-space body measurements for one frame, or a reason why the frame is unusable. */
function measure(lm, w, h) {
  if (!lm) return { problem: 'No person detected – step into view' };
  const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h, v: lm[i].visibility ?? 1, inFrame: lm[i].x > 0.01 && lm[i].x < 0.99 && lm[i].y > 0.01 && lm[i].y < 0.99 });
  const pts = Object.fromEntries(KEY.map((i) => [i, P(i)]));
  if (KEY.some((i) => pts[i].v < VIS || !pts[i].inFrame)) {
    const feet = pts[27].v < VIS || pts[28].v < VIS || !pts[27].inFrame || !pts[28].inFrame;
    return { problem: feet ? 'Feet not visible – step back so your whole body is in frame' : 'Body partly out of frame – move to the centre' };
  }
  const sh = { x: (pts[11].x + pts[12].x) / 2, y: (pts[11].y + pts[12].y) / 2 };
  const hp = { x: (pts[23].x + pts[24].x) / 2, y: (pts[23].y + pts[24].y) / 2 };
  const torso = Math.hypot(sh.x - hp.x, sh.y - hp.y);
  if (torso < 20) return { problem: 'Too far away – step closer' };
  const bodyH = (Math.max(pts[27].y, pts[28].y) - Math.min(lm[0].y * h, sh.y)) / h;
  if (bodyH > 0.97) return { problem: 'Too close – step back' };
  return {
    torso,
    cx: (sh.x + hp.x) / 2, cy: (sh.y + hp.y) / 2,         // body centre
    ankleL: pts[27].y, ankleR: pts[28].y,
  };
}

function drawPose(canvas, lm, color) {
  const g = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth * devicePixelRatio, H = canvas.height = canvas.clientHeight * devicePixelRatio;
  g.clearRect(0, 0, W, H);
  if (!lm) return;
  g.strokeStyle = color; g.lineWidth = 5 * devicePixelRatio; g.lineCap = 'round';
  for (const [a, b] of SKELETON) {
    if ((lm[a].visibility ?? 1) < VIS || (lm[b].visibility ?? 1) < VIS) continue;
    g.beginPath(); g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); g.stroke();
  }
  g.fillStyle = '#fff';
  for (const i of KEY) { g.beginPath(); g.arc(lm[i].x * W, lm[i].y * H, 6 * devicePixelRatio, 0, 7); g.fill(); }
}

export async function runBalance(root, ctx) {
  const video = ctx.video();
  root.innerHTML = '';
  const ui = html`
    <div class="grid lg:grid-cols-[1.6fr_1fr] gap-8 items-start">
      <div class="cam-wrap aspect-video">
        <video playsinline muted></video><canvas></canvas>
        <div id="bal-overlay" class="absolute inset-0 grid place-items-center pointer-events-none"><div id="bal-count" class="big-count"></div></div>
      </div>
      <div class="card p-7 flex flex-col gap-5">
        <h3 class="text-2xl font-bold" id="bal-title">Position check</h3>
        <ul class="status-list">
          <li id="b-model">Loading body-tracking model…</li>
          <li id="b-body">Whole body visible</li>
          <li id="b-light">Lighting OK</li>
        </ul>
        <div id="b-warn" class="min-h-[3.5rem]"></div>
        <div class="timer-bar"><div id="b-bar"></div></div>
        <div class="text-6xl font-black tabular-nums text-center" id="b-time">15.0</div>
        <label class="flex flex-col gap-2 text-slate-400"><span>Camera</span><span id="cam-pick"></span></label>
        <p class="text-slate-400">The test starts automatically once your whole body has been visible for 2 seconds.</p>
      </div>
    </div>`;
  root.appendChild(ui);
  const preview = $('video', ui), canvas = $('canvas', ui), countEl = $('#bal-count', ui);
  const warn = $('#b-warn', ui), setWarn = (m) => { warn.innerHTML = m ? `<div class="banner banner-warn">⚠ ${m}</div>` : ''; };

  await startCamera(video);
  const attach = (s) => { preview.srcObject = s; preview.play().catch(() => {}); };
  attach(video.srcObject);
  $('#cam-pick', ui).appendChild(await cameraPicker(video, attach));
  const pose = await getPoseLandmarker();
  $('#b-model', ui).textContent = 'Body-tracking model ready';
  $('#b-model', ui).classList.add('ok');

  let running = true, raf = 0, lastVideoTime = -1, frame = 0;
  onCleanup(() => { running = false; cancelAnimationFrame(raf); });

  /** Detect on each new video frame; returns {lm, m} */
  let latest = { lm: null, m: { problem: 'No person detected' } };
  function detect() {
    if (video.currentTime === lastVideoTime) return null;
    lastVideoTime = video.currentTime;
    const res = pose.detectForVideo(video, videoTs());
    const lm = res.landmarks?.[0] || null;
    latest = { lm, m: measure(lm, video.videoWidth, video.videoHeight) };
    if (frame++ % 15 === 0) {
      const lmsg = lightingMessage(brightness(video));
      $('#b-light', ui).className = lmsg ? 'bad' : 'ok';
      $('#b-light', ui).textContent = lmsg || 'Lighting OK';
    }
    return latest;
  }

  // ---------------- 1) wait until the whole body is visible for 2 s
  await new Promise((resolve) => {
    let okSince = 0;
    const loop = () => {
      if (!running) return;
      const r = detect();
      if (r) {
        const ok = !r.m.problem;
        drawPose(canvas, r.lm, ok ? '#34d399' : '#f87171');
        $('#b-body', ui).className = ok ? 'ok' : 'bad';
        setWarn(r.m.problem);
        okSince = ok ? okSince || performance.now() : 0;
        if (okSince && performance.now() - okSince > 2000) return resolve();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  });
  if (!running) return null;

  // ---------------- 2) countdown, then "lift your foot"
  $('#bal-title', ui).textContent = 'Get ready…';
  setWarn('');
  await countdown(countEl, 3);
  countEl.textContent = '';
  $('#bal-title', ui).textContent = 'Raise one foot & hold still';

  // ---------------- 3) record 15 s
  const samples = [];
  let frames = 0;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const loop = () => {
      if (!running) return resolve();
      const t = performance.now() - t0;
      if (t >= DURATION_MS) return resolve();
      $('#b-bar', ui).style.width = `${(t / DURATION_MS) * 100}%`;
      $('#b-time', ui).textContent = ((DURATION_MS - t) / 1000).toFixed(1);
      const r = detect();
      if (r) {
        frames++;
        drawPose(canvas, r.lm, r.m.problem ? '#f87171' : '#22d3ee');
        setWarn(r.m.problem);
        if (!r.m.problem) samples.push({ t, ...r.m });
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  });
  if (!running) return null;
  beep(990, 0.3);
  $('#b-time', ui).textContent = '0.0';
  return analyse(samples, frames);
}

export { analyse as _analyse };  // exposed for self-tests

function analyse(samples, frames) {
  if (samples.length < 30) throw new Error('Not enough body data – make sure your whole body stays in view, then retry.');
  const torso = mean(samples.map((s) => s.torso));

  // --- sway: body centre in torso units, lightly smoothed (5-frame moving average) to remove jitter
  const raw = samples.map((s) => [s.cx / torso, s.cy / torso]);
  const sm = raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - 2), i + 3);
    return [mean(win.map((p) => p[0])), mean(win.map((p) => p[1]))];
  });
  const mx = mean(sm.map((p) => p[0])), my = mean(sm.map((p) => p[1]));
  const swayAmp = Math.sqrt(mean(sm.map(([x, y]) => (x - mx) ** 2 + (y - my) ** 2)));
  let path = 0;
  for (let i = 1; i < sm.length; i++) path += Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1]);
  const secs = (samples[samples.length - 1].t - samples[0].t) / 1000;

  // --- which foot is raised? the ankle that is higher (smaller y) on average
  const lift = mean(samples.map((s) => s.ankleR - s.ankleL));  // >0 -> left ankle higher
  const raisedLeft = lift > 0;
  const height = samples.map((s) => (raisedLeft ? s.ankleR - s.ankleL : s.ankleL - s.ankleR) / torso);

  // --- touch-downs: foot was up (> LIFTED), then down (< DOWN) for >= DOWN_MIN_MS
  let touchdowns = 0, up = false, downSince = null;
  samples.forEach((s, i) => {
    if (height[i] > LIFTED) { up = true; downSince = null; }
    else if (height[i] < DOWN && up) {
      downSince ??= s.t;
      if (s.t - downSince >= DOWN_MIN_MS) { touchdowns++; up = false; downSince = null; }
    }
  });
  // never lifted the foot at all -> the test was not performed properly
  const everLifted = height.some((x) => x > LIFTED);

  return {
    sway_amplitude: round(swayAmp, 4),
    sway_velocity: round(path / Math.max(1, secs), 3),
    touchdowns,
    foot_raised: raisedLeft ? 'left' : 'right',
    foot_lifted: everLifted,
    quality: round(Math.min(1, samples.length / Math.max(1, frames)) * (everLifted ? 1 : 0.5), 2),
  };
}
