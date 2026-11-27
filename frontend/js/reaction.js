// TEST 1 - Simple reaction time.
// The panel turns GREEN after a random 1.5-4 s wait; the user presses SPACE (or taps).
// Timing uses performance.now() / event.timeStamp (same high-resolution clock).
import { $, html, sleep, mean, median, sd, round, beep } from './ui.js';
import { onCleanup } from './app.js';

const TRIALS = 5;
const MIN_VALID_MS = 100;    // faster than this is physiologically an anticipation -> false start
const LAPSE_MS = 1500;       // slower than this is a lapse; capped so one lapse can't dominate
const MAX_FALSE_STARTS = 6;  // safety valve so the test always finishes

export function runReaction(root) {
  return new Promise((resolve) => {
    root.innerHTML = '';
    const ui = html`
      <div class="flex flex-col items-center gap-6 w-full">
        <div id="rt-panel" class="rt-panel rt-wait select-none">
          <div id="rt-msg" class="text-4xl md:text-6xl font-bold">Get ready…</div>
          <div class="text-xl opacity-80 mt-4">Press <kbd>SPACE</kbd> or tap when the panel turns <b class="text-emerald-300">GREEN</b></div>
        </div>
        <div id="rt-trials" class="flex gap-3"></div>
      </div>`;
    root.appendChild(ui);
    const panel = $('#rt-panel', ui), msg = $('#rt-msg', ui), chips = $('#rt-trials', ui);
    for (let i = 0; i < TRIALS; i++) chips.appendChild(html`<div class="chip">–</div>`);

    const times = [];
    let falseStarts = 0, state = 'idle', greenAt = 0, timer = null;

    function setPanel(cls, text) {
      panel.className = `rt-panel ${cls} select-none`;
      msg.textContent = text;
    }

    async function nextTrial() {
      if (state === 'cancelled') return;
      if (times.length >= TRIALS || falseStarts >= MAX_FALSE_STARTS) return finish();
      state = 'waiting';
      setPanel('rt-wait', 'Wait for green…');
      const delay = 1500 + Math.random() * 2500;
      timer = setTimeout(() => {
        panel.className = 'rt-panel rt-go select-none';
        msg.textContent = 'NOW!';
        // rAF fires just before the frame that shows green is painted -> best estimate of stimulus onset
        requestAnimationFrame((t) => { greenAt = t; state = 'go'; });
      }, delay);
    }

    async function onPress(ts) {
      if (state === 'waiting') {                 // pressed before green
        clearTimeout(timer);
        falseStarts++;
        state = 'penalty';
        beep(220, 0.2);
        setPanel('rt-early', 'Too early!');
        await sleep(1200);
        return nextTrial();
      }
      if (state !== 'go') return;
      state = 'done';
      const rt = ts - greenAt;
      if (rt < MIN_VALID_MS) {                   // anticipation
        falseStarts++;
        setPanel('rt-early', 'Too early!');
        await sleep(1200);
        return nextTrial();
      }
      const capped = Math.min(rt, LAPSE_MS);
      times.push(capped);
      const chip = chips.children[times.length - 1];
      chip.textContent = `${Math.round(capped)} ms`;
      chip.classList.add('chip-done');
      setPanel('rt-wait', `${Math.round(capped)} ms`);
      await sleep(900);
      nextTrial();
    }

    const onKey = (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (!e.repeat) onPress(e.timeStamp);
    };
    const onTouch = (e) => { e.preventDefault(); onPress(e.timeStamp); };

    function finish() {
      window.removeEventListener('keydown', onKey);
      panel.removeEventListener('pointerdown', onTouch);
      setPanel('rt-done', 'Done ✓');
      resolve({
        mean_ms: round(mean(times)),
        median_ms: round(median(times)),
        sd_ms: round(sd(times)),
        false_starts: falseStarts,
        trials: times.map((t) => round(t)),
        quality: times.length / TRIALS,
      });
    }

    window.addEventListener('keydown', onKey);
    panel.addEventListener('pointerdown', onTouch);
    onCleanup(() => {                       // "Skip this test" pressed mid-test
      clearTimeout(timer);
      state = 'cancelled';
      window.removeEventListener('keydown', onKey);
      panel.removeEventListener('pointerdown', onTouch);
    });
    sleep(800).then(() => state === 'idle' && nextTrial());
  });
}
