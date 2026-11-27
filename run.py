"""
Start SafeCheck:   python run.py
Re-launches itself inside .venv (created by install.py), starts the API + web app
and opens the browser at http://127.0.0.1:8000
"""
import json
import os
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_PY = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def in_venv() -> bool:
    return Path(sys.prefix).resolve() == (ROOT / ".venv").resolve()


if __name__ == "__main__":
    if not in_venv():
        if not VENV_PY.exists():
            sys.exit("No .venv found. Run setup first:  python install.py")
        sys.exit(subprocess.call([str(VENV_PY), str(ROOT / "run.py"), *sys.argv[1:]]))

    if not (ROOT / "frontend/vendor/mediapipe/vision_bundle.mjs").exists():
        print("WARNING: browser assets missing - run `python install.py` (Demo mode still works).")

    cfg = json.loads((ROOT / "config/config.json").read_text(encoding="utf-8"))["app"]
    url = f"http://{cfg['host']}:{cfg['port']}"
    if "--no-browser" not in sys.argv:
        threading.Timer(2.0, lambda: webbrowser.open(url)).start()
    print(f"\n  SafeCheck running at {url}   (admin dashboard: {url}/dashboard.html)\n")

    import uvicorn
    sys.path.insert(0, str(ROOT))
    uvicorn.run("backend.main:app", host=cfg["host"], port=cfg["port"], log_level="info", use_colors=False)
