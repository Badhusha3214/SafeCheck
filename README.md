# SafeCheck

**A 2-minute, laptop-only drug-impairment *screening* tool, inspired by police field sobriety tests.**
Webcam + microphone only. Runs fully offline after a one-time setup.

> ⚠ **Screening only — not a medical or legal test.** Results can be affected by fatigue, illness,
> medication, injury, disability, language and camera conditions. A "Flag" is a prompt for proper
> assessment, never proof of impairment.

| Test | What it measures | How |
|---|---|---|
| ⚡ **Reaction time** | mean, median, variability, false starts | 5 trials, panel turns green at random 1.5–4 s; `performance.now()` timing |
| 👁 **Eye tracking** (smooth pursuit) | gaze error, pursuit correlation, eye lag, catch-up saccades | MediaPipe Face Landmarker iris landmarks, 5-point calibration, 15 s moving dot |
| 🧍 **One-leg balance** | sway amplitude, sway velocity, foot touch-downs | MediaPipe Pose (shoulders, hips, ankles), 15 s, measured in torso lengths |
| 🗣 **Speech** | words/min, pauses, word error rate (slurring proxy) | faster-whisper `small` (English + Malayalam) + librosa |

Each test is scored 0–100 against a normal range, then combined into **Normal / Borderline / Flag**,
with a radar chart and per-test breakdown.

---

## Quick start

Requirements: **Python 3.10+**, Chrome or Edge, a webcam and a microphone. Internet only for setup.

```bash
python install.py      # once: creates .venv, installs packages, downloads models (~520 MB)
python run.py          # every time: starts the app and opens http://127.0.0.1:8000
```

* Admin dashboard: <http://127.0.0.1:8000/dashboard.html>
* `python install.py --no-whisper` skips the speech model (speech test can then be skipped).
* `python run.py --no-browser` starts without opening a browser.

## Using it

1. **Start screen** – optional name/ID, speech language, consent checkbox.
2. **Reaction** – press <kbd>Space</kbd> (or tap) when the panel turns green.
3. **Eyes** – sit ~an arm's length away, face lit from the front, head still. Look at 5 calibration dots, then follow the moving dot with your eyes. <kbd>Esc</kbd> aborts.
4. **Balance** – stand ~2 m back so head-to-feet is visible; the test auto-starts when your whole body has been visible for 2 s; raise one foot for 15 s.
5. **Speech** – read the sentence aloud; recording stops automatically or with **Stop**.
6. **Results** – verdict, radar chart, every metric with its normal range, and *why* the result was given.

Every test can be **retried** or **skipped**. Built-in error handling: no camera / permission denied /
camera busy, virtual-camera detection with a camera picker, "no face detected", "feet not visible – step back",
"too dark / backlit", "no voice detected", speech model missing, backend unreachable.

### Demo mode (for pitches)
Click **▶ Demo mode** on the start screen and pick **Sober volunteer** or **Impaired (simulated)**.
Each test replays as a short animation, then the sample is scored by the real backend
(not saved). Works without camera, microphone or speech model. "Skip to results" jumps ahead.

### Baseline mode (building the normal range)
1. On the start screen open **Admin options → Baseline collection mode** (or go to `/?mode=baseline`).
2. Run the full test with sober volunteers.
3. Once `baseline.min_sessions` (default **5**) exist, every metric's normal range becomes
   **baseline mean ± 2 SD** instead of the defaults in `config/config.json`.
   Speech norms are learned per language. The dashboard shows which ranges are default vs learned.

### Dashboard
Session list with filters (name, mode, result, date), **CSV export** (respects filters), session
detail view, delete, summary charts (results split, average score per test, score per session)
and the live normal-range table.

---

## How scoring works

Fully commented in [`backend/scoring.py`](backend/scoring.py). In short:

1. **Normal range** per metric = mean ± 2 SD (defaults from config, or learned from baseline volunteers).
2. **z-score in the impaired direction** – e.g. slower reaction or *lower* speaking rate. Being better than average is never penalised.
3. **Metric score**: z ≤ 0 → 100 · z = 2 (edge of normal) → **70** · z = 4 → 0 (linear in between).
4. **Test score** = weighted mean of its metrics. Tests with poor capture quality (e.g. face visible < 60 % of the time, foot never lifted) are **excluded** and reported, not silently scored.
5. **Overall** = weighted mean of reliable tests → **≥ 70 Normal · ≥ 50 Borderline · else Flag**.
   Safety rules: one test < 40 caps the result at Borderline; two such tests → Flag; fewer than 2 reliable tests → Incomplete.

All thresholds, weights and default ranges live in [`config/config.json`](config/config.json) — no code changes needed.

> The default ranges are sensible starting points, **not clinically validated norms**. Collect a
> baseline on your own hardware before relying on the numbers (webcam latency, for example, adds
> ~100 ms to the measured eye lag).

---

## Project structure

```
├── install.py               one-time setup (venv, packages, offline assets, whisper model)
├── run.py                   start command
├── requirements.txt
├── config/config.json       normal ranges, weights, thresholds, sentences
├── backend/
│   ├── main.py              FastAPI: API + serves the frontend
│   ├── scoring.py           metrics → scores → verdict (read this first)
│   ├── speech.py            faster-whisper + librosa analysis
│   ├── db.py                SQLite (data/safecheck.db)
│   └── sample_sessions.json demo-mode sample data
└── frontend/
    ├── index.html           test flow          dashboard.html  admin page
    ├── css/app.css
    ├── js/app.js            flow controller    js/ui.js, js/camera.js (shared)
    ├── js/reaction.js  js/eyes.js  js/balance.js  js/speech.js   ← one file per test
    ├── js/results.js   js/demo.js  js/dashboard.js
    └── vendor/              MediaPipe, models, Chart.js, Tailwind (downloaded by install.py)
```

### API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config?lang=en` | sentences, scoring config, effective norms, speech-model status |
| POST | `/api/speech` | multipart `audio` + `lang` → speech metrics + transcript |
| POST | `/api/sessions` | `{subject, mode, lang, metrics, save}` → scores (+ saves) |
| GET | `/api/sessions` | list; filters `mode, result, q, date_from, date_to` |
| GET / DELETE | `/api/sessions/{id}` | detail / delete |
| GET | `/api/export.csv` | CSV export (same filters) |
| GET | `/api/baseline?lang=en` | baseline count + effective norms |
| GET | `/api/demo` | demo sample sessions |

Set `SAFECHECK_DB=path/to/other.db` to use a separate database (e.g. for rehearsals).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Camera shows a "camera off" picture | A virtual camera (OBS, Snap, Teams…) is selected. Pick the real one in the **Camera** dropdown on the eye/balance screen (remembered). |
| "Camera permission was denied" | Click the camera icon in the address bar → Allow, then **Retry**. |
| "Calibration failed: eye movement too small" | Sit closer, light your face from the front, look directly at each dot. |
| "Feet not visible" | Step back until head to feet are on screen; avoid cropping by the desk. |
| Speech model problem | Run `python install.py` (needs ~480 MB). The rest of the app works without it. |
| Port 8000 in use | Change `app.port` in `config/config.json`. |
| Live detection fails on stage | Use **Demo mode**. |

The first speech analysis after startup is pre-warmed (~15 s after `run.py`); afterwards each takes ~5 s on CPU.

## Privacy
Camera frames are processed in the browser and never leave the laptop; audio is sent only to the
local backend. Sessions are stored in `data/safecheck.db` on this machine. Delete that file to wipe all data.
