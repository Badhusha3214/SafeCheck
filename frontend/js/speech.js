// TEST 4 - Speech. The user reads a fixed sentence; audio is analysed by the backend
// (faster-whisper transcription + librosa pause/rate analysis, see backend/speech.py).
//
// Microphone handling: virtual microphones (screen-recorders, Voicemeeter, …) often deliver pure
// silence, so a physical mic is preferred, a picker is shown, and a live level meter runs from the
// moment the screen opens - the user can see the mic works BEFORE recording.
import { $, html, esc, sleep } from './ui.js';
import { VIRTUAL } from './camera.js';
import { onCleanup } from './app.js';

const MAX_MS = 15000, MIN_MS = 1200;
const MIC_KEY = 'safecheck.micId';
const SILENT_RMS = 0.004;   // below this for a whole recording = the mic delivered (almost) nothing

async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

function micError(e) {
  return new Error({
    NotAllowedError: 'Microphone permission denied. Click the icon in the address bar, allow the microphone, then retry.',
    NotFoundError: 'No microphone found.',
    NotReadableError: 'The microphone is in use by another app.',
  }[e.name] || `Microphone error: ${e.message}`);
}

/** Open the saved mic, else the default - but swap a virtual default for a physical microphone. */
async function openBestMic() {
  const saved = localStorage.getItem(MIC_KEY);
  if (saved) {
    try { return await openMic(saved); } catch (e) { if (e.name === 'NotAllowedError') throw micError(e); }
  }
  let s;
  try { s = await openMic(null); } catch (e) { throw micError(e); }
  if (VIRTUAL.test(s.getAudioTracks()[0]?.label || '')) {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label && !VIRTUAL.test(d.label));
    const best = mics.find((d) => d.deviceId === 'default') || mics[0];
    if (best) { s.getTracks().forEach((t) => t.stop()); s = await openMic(best.deviceId); }
  }
  return s;
}

export async function runSpeech(root, ctx) {
  const { state } = ctx;
  const sentences = state.config?.sentences || {};
  root.innerHTML = '';
  const ui = html`
    <div class="flex flex-col gap-6">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-slate-400 font-semibold">Language:</span>
        <button class="btn btn-sm" data-lang="en">English</button>
        <button class="btn btn-sm" data-lang="ml">മലയാളം</button>
        <span id="sp-model" class="ml-auto"></span>
      </div>
      <div class="card"><p class="eyebrow px-10 pt-8">Read this aloud</p><div id="sp-sentence" class="sentence"></div></div>
      <div class="card p-6 flex flex-col gap-4">
        <div class="flex items-center gap-4 flex-wrap">
          <button id="sp-rec" class="btn btn-primary btn-xl" disabled>🎙 Start recording</button>
          <button id="sp-stop" class="btn btn-danger btn-xl hidden">■ Stop</button>
          <div id="sp-live" class="hidden flex items-center gap-3 text-xl font-bold"><span class="rec-dot"></span><span id="sp-time">0.0 s</span></div>
          <label class="ml-auto flex items-center gap-2 text-slate-400">Microphone <select id="sp-mic" class="input !py-2 !w-auto max-w-xs"></select></label>
        </div>
        <div class="flex items-center gap-3"><span class="text-slate-400 text-sm w-16">Level</span><div class="level flex-1"><div id="sp-level"></div></div></div>
        <div id="sp-status"><p class="text-slate-400">Say something — the level bar should move.</p></div>
      </div>
    </div>`;
  root.appendChild(ui);
  const status = $('#sp-status', ui), recBtn = $('#sp-rec', ui), level = $('#sp-level', ui), micSel = $('#sp-mic', ui);
  const setStatus = (h) => (status.innerHTML = h);

  const setLang = (l) => {
    state.lang = l;
    $('#sp-sentence', ui).textContent = sentences[l] || '(sentence missing from config.json)';
    $('#sp-sentence', ui).lang = l;
    ui.querySelectorAll('[data-lang]').forEach((b) => (b.className = `btn btn-sm ${b.dataset.lang === l ? 'btn-primary' : 'btn-ghost'}`));
  };
  ui.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  setLang(state.lang in sentences ? state.lang : 'en');

  const sm = state.config?.speech_model;
  if (sm && !sm.loaded) {
    $('#sp-model', ui).innerHTML = sm.error
      ? '<span class="badge badge-amber">Speech model problem</span>'
      : '<span class="badge badge-violet">Speech model warming up…</span>';
  }

  // ---------------- live microphone + level meter (runs the whole time this screen is open)
  let mic = null, ac = null, analyser = null, raf = 0, recorder = null, timer = 0;
  let rms = 0, recordingPeak = 0, recording = false;
  const buf = new Uint8Array(1024);

  function meter() {
    analyser.getByteTimeDomainData(buf);
    let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
    rms = Math.sqrt(s / buf.length);
    if (recording) recordingPeak = Math.max(recordingPeak, rms);
    level.style.width = `${Math.min(100, rms * 500)}%`;
    raf = requestAnimationFrame(meter);
  }

  async function attachMic(stream) {
    cancelAnimationFrame(raf);
    mic?.getTracks().forEach((t) => t.stop());
    mic = stream;
    ac ||= new AudioContext();
    if (ac.state === 'suspended') await ac.resume();
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(mic).connect(analyser);
    meter();
    // fill the picker (labels are only available after permission)
    const cur = mic.getAudioTracks()[0]?.getSettings().deviceId;
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    micSel.innerHTML = mics.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Microphone')}${VIRTUAL.test(d.label) ? ' (virtual)' : ''}</option>`).join('');
  }

  micSel.onchange = async () => {
    localStorage.setItem(MIC_KEY, micSel.value);
    try { await attachMic(await openMic(micSel.value)); setStatus('<p class="text-slate-400">Microphone switched — say something to test the level.</p>'); }
    catch (e) { setStatus(`<div class="banner banner-error">⚠ ${esc(micError(e).message)}</div>`); }
  };

  const release = () => {
    cancelAnimationFrame(raf); clearTimeout(timer);
    if (recorder?.state === 'recording') recorder.stop();
    mic?.getTracks().forEach((t) => t.stop()); mic = null;
    ac?.close().catch(() => {}); ac = null;
  };
  onCleanup(release);

  try {
    await attachMic(await openBestMic());
    recBtn.disabled = false;
  } catch (e) {
    setStatus(`<div class="banner banner-error">⚠ ${esc(e.message)}</div>`);
    recBtn.disabled = false;   // pressing record retries opening the mic
  }
  if (sm?.error) setStatus(`<div class="banner banner-warn">⚠ ${esc(sm.error)}</div>`);

  // ---------------- record / analyse loop (fixable errors loop back to "Record again")
  while (true) {
    await new Promise((r) => (recBtn.onclick = r));
    let blob;
    try {
      if (!mic?.active) await attachMic(await openBestMic());
      blob = await record();
    } catch (e) {
      setStatus(`<div class="banner banner-error">⚠ ${esc(e.message)}</div>`);
      continue;
    }
    setStatus('<div class="flex items-center gap-4 text-xl"><div class="spinner"></div>Analysing speech…</div>');
    recBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('audio', blob, blob.type.includes('ogg') ? 'rec.ogg' : 'rec.webm');
      fd.append('lang', state.lang);
      const r = await fetch('/api/speech', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `Server error ${r.status}`);
      setStatus(`<div class="banner banner-ok">Heard: “${esc(data.transcript || '…')}”</div>`);
      await sleep(1800);
      return data;
    } catch (e) {
      setStatus(`<div class="banner banner-error">⚠ ${esc(e.message)} Press “Record again” to retry${/model/i.test(e.message) ? ', or skip this test' : ''}.</div>`);
    } finally {
      recBtn.disabled = false;
      recBtn.textContent = '🎙 Record again';
    }
  }

  async function record() {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(mic, mime ? { mimeType: mime } : {});
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));

    recordingPeak = 0; recording = true;
    recBtn.classList.add('hidden');
    $('#sp-stop', ui).classList.remove('hidden');
    $('#sp-live', ui).classList.remove('hidden');
    micSel.disabled = true;
    setStatus('<p class="text-slate-400 text-lg">Recording… read the sentence, then press Stop.</p>');

    const t0 = performance.now();
    const clock = setInterval(() => ($('#sp-time', ui).textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
    recorder.start(250);
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, MAX_MS))),
      new Promise((r) => ($('#sp-stop', ui).onclick = () => (performance.now() - t0 > MIN_MS ? r() : null)))]);
    if (recorder.state === 'recording') { recorder.stop(); await done; }
    clearInterval(clock); clearTimeout(timer);
    recording = false;
    recBtn.classList.remove('hidden');
    $('#sp-stop', ui).classList.add('hidden');
    $('#sp-live', ui).classList.add('hidden');
    micSel.disabled = false;

    if (recordingPeak < SILENT_RMS) {
      const label = mic.getAudioTracks()[0]?.label || 'this microphone';
      throw new Error(`No sound reached the app from “${label}”. Pick your real microphone in the Microphone list (the level bar should move when you talk), then press Record again.`);
    }
    return new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  }
}
