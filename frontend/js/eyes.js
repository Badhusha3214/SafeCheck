// TEST 2 - Smooth-pursuit eye tracking (inspired by the HGN part of field sobriety tests).
//
// How gaze is estimated from a normal webcam:
//   For each eye we take the iris centre (MediaPipe landmarks 468 / 473) and express it
//   relative to that eye's two corners:  h = position along the corner-to-corner line (0..1),
//   v = perpendicular offset / eye width. Both eyes are averaged. Because this is relative
//   to the eye itself, small head movements largely cancel out.
//   A 5-point calibration then fits  screen_x = a*h + b  and  screen_y = c*v + d.
//
// Metrics (all on the horizontal axis, which webcams track far more reliably than vertical):
//   lag_ms          delay that best aligns gaze with the target (eyes trailing behind)
//   tracking_error  RMS distance between gaze and lag-corrected target (fraction of screen width)
//   correlation     Pearson r between gaze and target (1 = perfect smooth pursuit)
//   saccades_per_s  "catch-up" jumps: gaze velocity spikes far faster than the target ever moves
import { $, html, sleep, mean, median, sd, round } from './ui.js';
import { startCamera, getFaceLandmarker, brightness, lightingMessage, videoTs, cameraPicker } from './camera.js';
import { onCleanup } from './app.js';

const CAL_POINTS = [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.12], [0.5, 0.88]];
const CAL_MS = 1000, CAL_SETTLE_MS = 400;          // 5 x 1 s = 5 s calibration
const H_MS = 8000, C_MS = 7000;                    // 8 s horizontal + 7 s circle = 15 s pursuit
const JUMP_IGNORE_MS = 700;                        // ignore eye re-fixation after the dot jumps to the circle
const SACCADE_V = 1.8;                             // screen-widths / s (target never exceeds ~0.6)

// eye landmark indices: [cornerA (image-left), cornerB (image-right), iris centre]
const EYES = [[33, 133, 468], [362, 263, 473]];

function gazeFeature(lm, w, h) {
  const P = (i) => [lm[i].x * w, lm[i].y * h];
  const hs = [], vs = [];
  for (const [a, b, ir] of EYES) {
    const A = P(a), B = P(b), I = P(ir);
    const vx = B[0] - A[0], vy = B[1] - A[1], len2 = vx * vx + vy * vy, len = Math.sqrt(len2);
    if (len < 4) return null;
    hs.push(((I[0] - A[0]) * vx + (I[1] - A[1]) * vy) / len2);
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    vs.push(((I[0] - mx) * -vy + (I[1] - my) * vx) / len2);
  }
  const nose = P(1), faceW = Math.hypot(P(234)[0] - P(454)[0], P(234)[1] - P(454)[1]);
  return { h: mean(hs), v: mean(vs), nx: nose[0] / faceW, ny: nose[1] / faceW };
}

function fitLine(xs, ys) {           // least squares y = a*x + b
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  const a = den ? num / den : 0;
  return { a, b: my - a * mx };
}

function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

const median3 = (arr) => arr.map((_, i) => (i === 0 || i === arr.length - 1 ? arr[i] : median([arr[i - 1], arr[i], arr[i + 1]])));

/** Target position (fraction of stage) at time t (ms since pursuit start). */
function targetAt(t, aspect) {
  if (t < H_MS) return [0.5 + 0.38 * Math.sin((2 * Math.PI * t) / 4000), 0.5];
  const a = (2 * Math.PI * (t - H_MS)) / 3500, r = 0.3;
  return [0.5 + (r / aspect) * Math.cos(a), 0.5 + r * Math.sin(a)];
}

export async function runEyes(root, ctx) {
  const video = ctx.video();
  root.innerHTML = '';
  const pre = html`
    <div class="grid md:grid-cols-[1.4fr_1fr] gap-8 items-start">
      <div class="cam-wrap aspect-video"><video playsinline muted></video><canvas></canvas></div>
      <div class="card p-7 flex flex-col gap-6">
        <h3 class="text-2xl font-bold">Pre-check</h3>
        <ul class="status-list">
          <li id="st-model">Loading eye-tracking model…</li>
          <li id="st-face">Face detected</li>
          <li id="st-light">Lighting OK</li>
        </ul>
        <label class="flex flex-col gap-2 text-slate-400"><span>Camera</span><span id="cam-pick"></span></label>
        <button id="eyes-start" class="btn btn-primary btn-xl" disabled>Start calibration</button>
        <p class="text-slate-400">Keep your head still. Press <kbd>Esc</kbd> to abort.</p>
      </div>
    </div>`;
  root.appendChild(pre);
  const preview = $('video', pre);

  await startCamera(video);
  const attach = (s) => { preview.srcObject = s; preview.play().catch(() => {}); };
  attach(video.srcObject);
  $('#cam-pick', pre).appendChild(await cameraPicker(video, attach));
  const face = await getFaceLandmarker();
  $('#st-model', pre).textContent = 'Eye-tracking model ready';
  $('#st-model', pre).classList.add('ok');

  let running = true, raf = 0;
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  onCleanup(() => { stop(); document.querySelector('.stage')?.remove(); });

  // ---------------- pre-check loop: face + lighting
  await new Promise((resolve) => {
    let okSince = 0, frame = 0, lightMsg = null;
    const btn = $('#eyes-start', pre);
    btn.onclick = () => resolve();
    const loop = () => {
      if (!running) return;
      const res = face.detectForVideo(video, videoTs());
      const has = res.faceLandmarks?.length > 0;
      if (frame++ % 15 === 0) lightMsg = lightingMessage(brightness(video));
      $('#st-face', pre).className = has ? 'ok' : 'bad';
      $('#st-face', pre).textContent = has ? 'Face detected' : 'No face detected – look at the screen';
      $('#st-light', pre).className = lightMsg ? 'bad' : 'ok';
      $('#st-light', pre).textContent = lightMsg || 'Lighting OK';
      okSince = has ? okSince || performance.now() : 0;
      btn.disabled = !(okSince && performance.now() - okSince > 500);
      raf = requestAnimationFrame(loop);
    };
    loop();
  });
  cancelAnimationFrame(raf);

  // ---------------- full-screen stage
  const stage = html`
    <div class="stage">
      <canvas></canvas>
      <div class="stage-hud"><div id="hud-title">Calibration – look at the dot</div>
        <div class="timer-bar mt-3 w-96 mx-auto"><div id="hud-bar"></div></div></div>
      <div class="stage-warn"></div>
    </div>`;
  document.body.appendChild(stage);
  document.documentElement.requestFullscreen?.().catch(() => {});
  const canvas = $('canvas', stage), g = canvas.getContext('2d');
  const warnBox = $('.stage-warn', stage), bar = $('#hud-bar', stage), title = $('#hud-title', stage);
  const resize = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; };
  resize(); addEventListener('resize', resize);

  let aborted = false;
  const onKey = (e) => { if (e.key === 'Escape') aborted = true; };
  addEventListener('keydown', onKey);

  function drawDot(x, y, color = '#22d3ee') {
    const W = canvas.width, H = canvas.height, r = 16 * devicePixelRatio;
    g.clearRect(0, 0, W, H);
    g.shadowColor = color; g.shadowBlur = 30 * devicePixelRatio;
    g.fillStyle = color; g.beginPath(); g.arc(x * W, y * H, r, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#fff'; g.beginPath(); g.arc(x * W, y * H, r * 0.35, 0, Math.PI * 2); g.fill();
  }

  // Runs `durationMs` of frames; calls onFrame(t, feature|null) for every new video frame.
  let lastFace = performance.now();
  function phase(durationMs, draw, onFrame) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let lastVideoTime = -1;
      const loop = () => {
        if (!running || aborted) return resolve();
        const t = performance.now() - t0;
        if (t >= durationMs) return resolve();
        draw(t);
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const res = face.detectForVideo(video, videoTs());
          const lm = res.faceLandmarks?.[0];
          const f = lm ? gazeFeature(lm, video.videoWidth, video.videoHeight) : null;
          if (f) lastFace = performance.now();
          warnBox.innerHTML = performance.now() - lastFace > 700
            ? '<div class="banner banner-warn">⚠ Face not detected – look at the screen, keep your head still</div>' : '';
          onFrame(t, f);
        }
        raf = requestAnimationFrame(loop);
      };
      loop();
    });
  }

  try {
    // ---------------- calibration (5 s)
    const cal = [];
    for (let p = 0; p < CAL_POINTS.length; p++) {
      const [px, py] = CAL_POINTS[p], hs = [], vs = [];
      await phase(CAL_MS, (t) => { drawDot(px, py, '#fbbf24'); bar.style.width = `${((p + t / CAL_MS) / CAL_POINTS.length) * 100}%`; },
        (t, f) => { if (f && t > CAL_SETTLE_MS) { hs.push(f.h); vs.push(f.v); } });
      if (aborted) throw new Error('Eye test aborted.');
      if (hs.length < 3) throw new Error('Calibration failed: face not detected at one of the points. Improve lighting and keep your face in view.');
      cal.push({ x: px, y: py, h: median(hs), v: median(vs) });
    }
    const hSpan = Math.abs(cal[2].h - cal[1].h);
    if (hSpan < 0.025) {
      throw new Error('Calibration failed: eye movement too small to measure. Sit a bit closer to the laptop, improve lighting, and look directly at each dot.');
    }
    const fx = fitLine(cal.map((c) => c.h), cal.map((c) => c.x));
    const fy = fitLine(cal.map((c) => c.v), cal.map((c) => c.y));

    // ---------------- pursuit (15 s)
    title.textContent = 'Follow the dot with your eyes only';
    const aspect = innerWidth / innerHeight;
    const samples = [];
    let frames = 0;
    await phase(H_MS + C_MS, (t) => {
      const [x, y] = targetAt(t, aspect);
      drawDot(x, y); bar.style.width = `${(t / (H_MS + C_MS)) * 100}%`;
    }, (t, f) => {
      frames++;
      if (f) samples.push({ t, gx: fx.a * f.h + fx.b, gy: fy.a * f.v + fy.b, nx: f.nx, ny: f.ny });
    });
    if (aborted) throw new Error('Eye test aborted.');
    return analyse(samples, frames, aspect);
  } finally {
    stop();
    removeEventListener('keydown', onKey);
    removeEventListener('resize', resize);
    stage.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
}

export { analyse as _analyse, targetAt as _targetAt };  // exposed for self-tests

function analyse(samples, frames, aspect) {
  if (samples.length < 60) throw new Error('Not enough eye data (face lost too often). Please retry with better lighting.');
  // ignore the re-fixation right after the dot jumps onto the circle
  const s = samples.filter((p) => !(p.t >= H_MS && p.t < H_MS + JUMP_IGNORE_MS));
  const gx = median3(s.map((p) => p.gx));          // light de-noising
  const ts = s.map((p) => p.t);

  // 1) lag: shift the target back in time until it best matches the gaze
  let best = { lag: 0, err: Infinity };
  for (let lag = 0; lag <= 400; lag += 10) {
    let e = 0;
    for (let i = 0; i < ts.length; i++) e += (gx[i] - targetAt(Math.max(0, ts[i] - lag), aspect)[0]) ** 2;
    if (e < best.err) best = { lag, err: e };
  }
  const tx = ts.map((t) => targetAt(Math.max(0, t - best.lag), aspect)[0]);

  // 2) error + 3) correlation (lag-corrected)
  const tracking_error = Math.sqrt(best.err / ts.length);
  const correlation = pearson(gx, tx);

  // 4) catch-up saccades: velocity spikes, 150 ms refractory period
  let sacc = 0, lastSacc = -1e9;
  for (let i = 1; i < gx.length; i++) {
    const dt = (ts[i] - ts[i - 1]) / 1000;
    if (dt <= 0 || dt > 0.2) continue;
    if (Math.abs(gx[i] - gx[i - 1]) / dt > SACCADE_V && ts[i] - lastSacc > 150) { sacc++; lastSacc = ts[i]; }
  }
  const seconds = (ts[ts.length - 1] - ts[0]) / 1000;

  // capture quality: share of frames with a face, penalised if the head moved a lot
  const headMotion = Math.hypot(sd(s.map((p) => p.nx)), sd(s.map((p) => p.ny)));
  let quality = Math.min(1, samples.length / Math.max(1, frames));
  if (headMotion > 0.08) quality *= 0.7;

  return {
    tracking_error: round(tracking_error, 3),
    correlation: round(correlation, 3),
    lag_ms: best.lag,
    saccades_per_s: round(sacc / Math.max(1, seconds), 2),
    head_motion: round(headMotion, 3),
    quality: round(quality, 2),
    // downsampled trace (gaze vs target) for the results chart
    trace: s.filter((_, i) => i % 3 === 0).map((p, i) => [Math.round(p.t), round(gx[i * 3], 3), round(targetAt(p.t, aspect)[0], 3)]),
  };
}
