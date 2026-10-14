# Extra root CAs for networks that inspect TLS (corporate proxies): drop PEM files in certs/ — see
# certs/README.md. With none there, these are no-ops. update-ca-certificates silently skips a file that
# holds more than one certificate, so bundles are split into one certificate per .crt first.
ARG TRUST_EXTRA_CAS='mkdir -p /usr/local/share/ca-certificates/extra && \
  for f in /tmp/certs/*.crt /tmp/certs/*.pem; do [ -f "$f" ] || continue; \
    awk -v out="/usr/local/share/ca-certificates/extra/$(basename "$f" | sed "s/\.[^.]*$//")" \
      "/BEGIN CERTIFICATE/{n++} n{print > (out \"-\" n \".crt\")}" "$f"; done && \
  update-ca-certificates'

# ---- stage: build the PWA ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /fe
COPY certs/ /tmp/certs/
COPY frontend/package.json frontend/package-lock.json ./
# Node keeps its own CA list; NODE_EXTRA_CA_CERTS adds any certs/ for npm (no apt needed).
# The PWA is static output: skip install scripts so desktop-only native modules (SQLCipher, speech)
# aren't compiled for an image that never runs Electron.
RUN cat /tmp/certs/*.crt /tmp/certs/*.pem > /tmp/extra-cas.pem 2>/dev/null; \
    if [ -s /tmp/extra-cas.pem ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra-cas.pem; fi; \
    npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

# ---- stage: python backend (no frontend dependency -> usable as the dev target) ----
FROM python:3.12-slim AS base
ARG TRUST_EXTRA_CAS
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf \
    HUGGINGFACE_HUB_CACHE=/models/hf \
    SPEECHBRAIN_CACHE_DIR=/models/sb \
    TORCH_HOME=/models/torch \
    OMP_NUM_THREADS=2
COPY certs/ /tmp/certs/
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && sh -c "$TRUST_EXTRA_CAS"
# pip and requests use their own CA bundles unless told to use the system one.
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
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
