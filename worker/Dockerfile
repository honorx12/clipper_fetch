FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/app \
    DATA_DIR=/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# JS runtime that yt-dlp uses to solve YouTube challenges
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY worker.py .

RUN useradd -m app && mkdir -p /data && chown -R app:app /data /app

EXPOSE 8080
# Starts as root only to fix volume ownership, then runs as user "app".
CMD ["sh", "-c", "mkdir -p \"$DATA_DIR\" && chown -R app:app \"$DATA_DIR\" && exec setpriv --reuid=app --regid=app --init-groups uvicorn worker:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
