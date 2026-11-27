"""SafeCheck API + static file server.   Started by run.py  (backend.main:app)"""
from __future__ import annotations

import csv
import io
import json
import mimetypes
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, speech
from .scoring import TESTS, effective_norms, load_config, score_session

ROOT = Path(__file__).resolve().parent.parent

# Windows' registry often maps .mjs/.js to text/plain, which browsers refuse to run as modules.
for _ext, _type in {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                    ".css": "text/css", ".json": "application/json"}.items():
    mimetypes.add_type(_type, _ext)


@asynccontextmanager
async def lifespan(_app):
    """Load the speech model in the background so the first speech test is fast."""
    cfg = load_config()["app"]

    def load():
        try:
            model = speech.get_model(cfg["whisper_model"], cfg["whisper_compute_type"])
            # One tiny dummy transcription pays the cold-start cost (disk read, kernel setup)
            # at startup instead of during the first live speech test.
            import numpy as np
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
            import librosa  # first import + numba JIT is slow; do it now as well
            librosa.effects.split(np.random.default_rng(0).normal(0, 0.1, 16000).astype(np.float32), top_db=30)
            speech.mark_warm()
        except RuntimeError:
            pass  # reported to the UI via /api/config -> speech_model.error

    threading.Thread(target=load, daemon=True).start()
    yield


app = FastAPI(title="SafeCheck", version="1.0", lifespan=lifespan)


@app.middleware("http")
async def no_stale_cache(request, call_next):
    """Always revalidate (cheap via ETag) so an edited file is never served stale during a demo."""
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


class SessionIn(BaseModel):
    subject: str | None = None
    mode: str = "screening"          # screening | baseline
    lang: str | None = "en"
    metrics: dict                    # {test: {metric: value, quality: 0..1} | null}
    save: bool = True                # False = score only (demo mode)


def _norms(cfg, lang):
    return effective_norms(cfg, db.baseline_sessions(), lang)


# ----------------------------------------------------------------- config
@app.get("/api/config")
def get_config(lang: str = "en"):
    cfg = load_config()
    return {
        "sentences": cfg["sentences"],
        "scoring": cfg["scoring"],
        "norms": _norms(cfg, lang),
        "baseline_count": len(db.baseline_sessions()),
        "baseline_min": cfg["baseline"]["min_sessions"],
        "speech_model": speech.model_status(),
    }


# ----------------------------------------------------------------- speech
@app.post("/api/speech")
async def analyze_speech(audio: UploadFile = File(...), lang: str = Form("en")):
    cfg = load_config()
    if lang not in cfg["sentences"]:
        raise HTTPException(400, f"Unsupported language '{lang}'")
    suffix = Path(audio.filename or "rec.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        return await run_in_threadpool(
            speech.analyze, path, lang, cfg["sentences"][lang],
            cfg["app"]["whisper_model"], cfg["app"]["whisper_compute_type"],
        )
    except ValueError as e:          # user-fixable problems (silence, too short)
        raise HTTPException(422, str(e))
    except RuntimeError as e:        # model missing
        raise HTTPException(503, str(e))
    finally:
        Path(path).unlink(missing_ok=True)


# ----------------------------------------------------------------- sessions
@app.post("/api/sessions")
def create_session(s: SessionIn):
    if s.mode not in ("screening", "baseline"):
        raise HTTPException(400, "mode must be screening or baseline")
    cfg = load_config()
    scores = score_session(s.metrics, _norms(cfg, s.lang), cfg)
    sid = db.insert_session(s.subject, s.mode, s.lang, s.metrics, scores) if s.save else None
    return {"id": sid, **scores}


@app.get("/api/sessions")
def sessions(mode: str | None = None, result: str | None = None, q: str | None = None,
             date_from: str | None = None, date_to: str | None = None):
    return db.list_sessions(mode, result, q, date_from, date_to)


@app.get("/api/sessions/{sid}")
def session(sid: int):
    s = db.get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@app.delete("/api/sessions/{sid}")
def remove_session(sid: int):
    if not db.delete_session(sid):
        raise HTTPException(404, "Session not found")
    return {"ok": True}


@app.get("/api/export.csv")
def export_csv(mode: str | None = None, result: str | None = None, q: str | None = None,
               date_from: str | None = None, date_to: str | None = None):
    cfg = load_config()
    metric_cols = [(t, m) for t in TESTS for m in cfg["metrics"].get(t, {})]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "created_at", "subject", "mode", "lang", "overall_score", "result"]
               + [f"{t}_score" for t in TESTS] + [f"{t}.{m}" for t, m in metric_cols])
    for s in db.list_sessions(mode, result, q, date_from, date_to):
        tests = (s["scores"] or {}).get("tests", {})
        w.writerow(
            [s["id"], s["created_at"], s["subject"] or "", s["mode"], s["lang"] or "", s["overall_score"], s["result"]]
            + [tests.get(t, {}).get("score") for t in TESTS]
            + [(s["metrics"].get(t) or {}).get(m) for t, m in metric_cols]
        )
    return StreamingResponse(iter(["﻿" + buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=safecheck_sessions.csv"})


# ----------------------------------------------------------------- baseline + demo
@app.get("/api/baseline")
def baseline(lang: str = "en"):
    cfg = load_config()
    return {"count": len(db.baseline_sessions()), "min_sessions": cfg["baseline"]["min_sessions"],
            "norms": _norms(cfg, lang)}


@app.get("/api/demo")
def demo():
    return JSONResponse(json.loads((ROOT / "backend" / "sample_sessions.json").read_text(encoding="utf-8")))


# Static frontend last, so /api/* wins.
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
