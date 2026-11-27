"""
Speech analysis: faster-whisper (transcription) + librosa (timing).

Metrics
  wpm            words in the expected sentence / time from first to last voiced sound
  pause_count    silent gaps >= 0.3 s *inside* the utterance (hesitations)
  pause_total_s  total length of those gaps
  wer            word error rate of the transcript vs the expected sentence.
                 Used as a SLURRING PROXY: unclear articulation -> recogniser
                 makes more mistakes. (Malayalam has a higher default because
                 whisper-small is less accurate in Malayalam even for clear speech.)
  cer            character error rate (reported, not scored; more meaningful for Malayalam)
"""
from __future__ import annotations

import re
import threading
import unicodedata
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SR = 16000
PAUSE_MIN_S = 0.3

_model = None
_model_lock = threading.Lock()
_model_error: str | None = None


def get_model(name: str = "small", compute_type: str = "int8"):
    """Load the locally downloaded model (never touches the network -> offline-safe).
    A failed load is retried on the next call, so finishing install.py while the
    server runs is enough - no restart needed."""
    global _model, _model_error
    with _model_lock:
        if _model is None:
            local = ROOT / "models" / f"whisper-{name}"
            if not (local / "model.bin").exists():
                _model_error = f"Speech model not found in {local}. Run `python install.py`."
                raise RuntimeError(_model_error)
            try:
                from faster_whisper import WhisperModel
                _model = WhisperModel(str(local), device="cpu", compute_type=compute_type)
                _model_error = None
            except Exception as e:  # noqa: BLE001 - surface any load problem to the UI
                _model_error = f"Speech model could not be loaded: {e}"
                raise RuntimeError(_model_error) from e
        return _model


_warm = False


def mark_warm():
    global _warm
    _warm = True


def model_status() -> dict:
    """loaded = ready for fast transcription (model in memory and warmed up)."""
    return {"loaded": _model is not None and _warm, "error": _model_error}


# ------------------------------------------------------------------ text utils
def normalize(text: str) -> list[str]:
    """Lower-case, drop punctuation/symbols (Unicode-aware, keeps Malayalam vowel signs)."""
    text = unicodedata.normalize("NFC", text.lower())
    text = "".join(" " if unicodedata.category(c)[0] in "PS" else c for c in text)
    return re.sub(r"\s+", " ", text).strip().split()


def edit_distance(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def error_rate(ref: list, hyp: list) -> float:
    return min(1.0, edit_distance(ref, hyp) / max(1, len(ref)))


# ------------------------------------------------------------------ analysis
def analyze(audio_path: str, lang: str, expected: str, model_name="small", compute_type="int8") -> dict:
    import librosa
    from faster_whisper import decode_audio  # PyAV decoder: handles webm/ogg/wav, no ffmpeg needed

    audio = decode_audio(audio_path, sampling_rate=SR).astype(np.float32)
    duration = len(audio) / SR
    if duration < 1.0:
        raise ValueError("Recording too short. Please read the whole sentence.")
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if peak < 0.01:
        raise ValueError("No voice detected. Check the microphone and speak closer.")

    # --- timing from energy: non-silent intervals (30 dB below peak = silence)
    intervals = librosa.effects.split(audio, top_db=30, frame_length=1024, hop_length=256)
    # drop tiny blips (< 80 ms) such as clicks
    intervals = [iv for iv in intervals if (iv[1] - iv[0]) / SR >= 0.08]
    if not intervals:
        raise ValueError("No speech detected in the recording.")
    speech_start, speech_end = intervals[0][0] / SR, intervals[-1][1] / SR
    gaps = [(intervals[i + 1][0] - intervals[i][1]) / SR for i in range(len(intervals) - 1)]
    pauses = [g for g in gaps if g >= PAUSE_MIN_S]
    span = max(0.5, speech_end - speech_start)

    # --- transcription. NOTE: we deliberately do NOT give whisper the expected
    # sentence as a prompt - that would "auto-correct" slurred speech.
    model = get_model(model_name, compute_type)
    segments, _info = model.transcribe(audio, language=lang, beam_size=5,
                                       condition_on_previous_text=False, vad_filter=False)
    transcript = " ".join(s.text.strip() for s in segments).strip()

    ref_words, hyp_words = normalize(expected), normalize(transcript)
    wer = error_rate(ref_words, hyp_words)
    cer = error_rate(list("".join(ref_words)), list("".join(hyp_words)))

    # quality: did we hear roughly the whole sentence? (crude completeness check)
    quality = min(1.0, len(hyp_words) / max(1, len(ref_words))) if hyp_words else 0.0

    return {
        "wpm": round(len(ref_words) / (span / 60), 1),
        "pause_count": len(pauses),
        "pause_total_s": round(sum(pauses), 2),
        "wer": round(wer, 3),
        "cer": round(cer, 3),
        "duration_s": round(span, 2),
        "transcript": transcript,
        "expected": expected,
        "quality": round(quality, 2),
    }
