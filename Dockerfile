# SafeCheck - single container: FastAPI backend + static frontend.
# Build downloads the browser assets and the whisper model, so the image runs with no setup.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Same assets install.py fetches (MediaPipe, Chart.js, Tailwind) + the whisper model.
RUN python -c "import install; install.download_assets()" \
 && python -c "from faster_whisper import download_model; download_model('small', output_dir='models/whisper-small')" \
 && mkdir -p data

EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
