# SafeCheck - single container: FastAPI backend + static frontend.
# Build downloads the browser assets and the whisper model, so the image runs with no setup.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Same assets install.py fetches (MediaPipe, Chart.js, Tailwind) + the whisper model.
# "base" fits Render's free 512 MB instance; set SAFECHECK_WHISPER_MODEL=small on bigger hosts.
ARG SAFECHECK_WHISPER_MODEL=base
ENV SAFECHECK_WHISPER_MODEL=${SAFECHECK_WHISPER_MODEL}
RUN python -c "import install; install.download_assets()" \
 && python -c "import os; from faster_whisper import download_model; m=os.environ['SAFECHECK_WHISPER_MODEL']; download_model(m, output_dir=f'models/whisper-{m}')" \
 && mkdir -p data

EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
