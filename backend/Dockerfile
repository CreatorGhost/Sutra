# ---- stage: build the PWA ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
COPY frontend/package.json ./
COPY frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- stage: python backend (no frontend dependency -> usable as the dev target) ----
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf \
    HUGGINGFACE_HUB_CACHE=/models/hf \
    SPEECHBRAIN_CACHE_DIR=/models/sb \
    TORCH_HOME=/models/torch \
    OMP_NUM_THREADS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN pip install --upgrade pip && \
    pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ---- stage: full app image (backend + built PWA in ./static) ----
FROM base AS app
COPY --from=frontend /fe/dist ./static
