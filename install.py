"""
SafeCheck one-time setup (needs internet ONCE; afterwards everything runs offline).

    python install.py                # full setup
    python install.py --no-whisper   # skip the ~480 MB speech model

What it does:
  1. creates .venv and installs requirements.txt
  2. downloads MediaPipe JS/WASM + models, Chart.js and Tailwind into frontend/vendor/
  3. downloads the faster-whisper "small" model into models/
"""
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
VENDOR = ROOT / "frontend" / "vendor"

MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
ASSETS = {
    "mediapipe/vision_bundle.mjs": f"{MP}/vision_bundle.mjs",
    "mediapipe/wasm/vision_wasm_internal.js": f"{MP}/wasm/vision_wasm_internal.js",
    "mediapipe/wasm/vision_wasm_internal.wasm": f"{MP}/wasm/vision_wasm_internal.wasm",
    "mediapipe/wasm/vision_wasm_nosimd_internal.js": f"{MP}/wasm/vision_wasm_nosimd_internal.js",
    "mediapipe/wasm/vision_wasm_nosimd_internal.wasm": f"{MP}/wasm/vision_wasm_nosimd_internal.wasm",
    "models/face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "models/pose_landmarker_full.task": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    "chart.umd.min.js": "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
    "tailwind.js": "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11/dist/index.global.js",
}


def step(msg):
    print(f"\n==> {msg}", flush=True)


def ensure_venv():
    if not VENV_PY.exists():
        step("Creating virtual environment (.venv)")
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
    step("Installing Python packages")
    subprocess.check_call([str(VENV_PY), "-m", "pip", "install", "--upgrade", "pip"])
    subprocess.check_call([str(VENV_PY), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")])


def download_assets():
    step("Downloading browser assets into frontend/vendor/")
    for rel, url in ASSETS.items():
        dest = VENDOR / rel
        if dest.exists() and dest.stat().st_size > 0:
            print(f"   ok      {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"   fetch   {rel}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.replace(dest)


def download_whisper():
    step("Downloading faster-whisper 'small' model (~480 MB, multilingual incl. Malayalam)")
    out = ROOT / "models" / "whisper-small"
    code = f"from faster_whisper import download_model; print('   saved to', download_model('small', output_dir=r'{out}'))"
    subprocess.check_call([str(VENV_PY), "-c", code])


if __name__ == "__main__":
    ensure_venv()
    download_assets()
    if "--no-whisper" not in sys.argv:
        download_whisper()
    print("\nSetup complete. Start SafeCheck with:  python run.py\n")
