"""ClipFetch worker: HTTP service wrapping yt-dlp + ffmpeg.

Endpoints (all JSON, header X-Worker-Secret required except /health and /download):
  GET  /health
  POST /info            {url}
  POST /jobs            {url, start, end, height, container, attested}
  GET  /jobs/{id}
  GET  /download/{id}?exp=..&sig=..   (signed link, opened by the browser)

Job state is kept in memory: run ONE instance of this service.
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("clipfetch")


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
if len(WORKER_SECRET) < 16:
    raise RuntimeError("WORKER_SECRET must be set (16+ characters).")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/clipfetch"))
JOBS_DIR = DATA_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
LIB_DIR = DATA_DIR / "library"
LIB_DIR.mkdir(parents=True, exist_ok=True)
INDEX_PATH = LIB_DIR / "index.json"

MAX_SECONDS_UHD = _int_env("MAX_SECONDS_UHD", 300)
MAX_SECONDS_HD = _int_env("MAX_SECONDS_HD", 900)
MAX_CONCURRENT = max(1, _int_env("MAX_CONCURRENT", 1))
MAX_JOBS_PER_HOUR = _int_env("MAX_JOBS_PER_HOUR", 5)
JOB_TIMEOUT = _int_env("JOB_TIMEOUT", 900)
INFO_TIMEOUT = _int_env("INFO_TIMEOUT", 30)
FILE_TTL = _int_env("FILE_TTL", 7200)
LINK_TTL = 3600
PROXY_URL = os.environ.get("PROXY_URL", "").strip()

ALLOWED_HEIGHTS = [2160, 1440, 1080, 720, 480, 360]
ACTIVE = ("queued", "fetching", "converting")

COOKIES_PATH: Optional[Path] = None
_b64 = os.environ.get("YTDLP_COOKIES_B64", "").strip()
if _b64:
    try:
        COOKIES_PATH = DATA_DIR / "cookies.txt"
        COOKIES_PATH.write_bytes(base64.b64decode(_b64))
        os.chmod(COOKIES_PATH, 0o600)
    except Exception:  # noqa: BLE001
        log.exception("Could not decode YTDLP_COOKIES_B64; continuing without cookies")
        COOKIES_PATH = None

# ---------------------------------------------------------------- errors


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def map_error(text: str) -> ApiError:
    s = text.lower()
    if "sign in to confirm" in s or "http error 429" in s or "too many requests" in s:
        return ApiError(
            "UPSTREAM_BLOCKED",
            "YouTube is blocking the server right now. Try again later.",
            503,
        )
    if "private video" in s:
        return ApiError("PRIVATE", "This video is private.", 403)
    if "confirm your age" in s or "age-restricted" in s or "age restricted" in s:
        return ApiError("AGE_RESTRICTED", "This video is age-restricted and can't be clipped.", 403)
    if "not available in your country" in s or "blocked it in your country" in s:
        return ApiError("GEO_BLOCKED", "This video is blocked in the server's region.", 403)
    if "live event will begin" in s or "premieres in" in s or "this live event" in s:
        return ApiError("LIVE_IN_PROGRESS", "This stream hasn't ended yet. Try again once it has.", 409)
    if (
        "video unavailable" in s
        or "has been removed" in s
        or "this video is not available" in s
        or "does not exist" in s
    ):
        return ApiError("UNAVAILABLE", "This video is unavailable.", 404)
    log.warning("Unmapped yt-dlp error: %s", text[-1500:])
    return ApiError("INTERNAL", "Something went wrong while reading the video. Try again.", 500)


# ---------------------------------------------------------------- helpers

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")
HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}
PCT_RE = re.compile(r"\[download\]\s+([\d.]+)%")
TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def canonical_url(raw: str) -> tuple[str, str]:
    """Return (video_id, canonical watch URL). Rejects anything not YouTube."""
    bad = ApiError("INVALID_URL", "Paste a YouTube video, live-stream or Shorts link.", 400)
    try:
        u = urlparse((raw or "").strip())
        host = (u.hostname or "").lower()
    except ValueError:
        raise bad
    if u.scheme not in ("http", "https") or host not in HOSTS:
        raise bad
    vid: Optional[str] = None
    if host.endswith("youtu.be"):
        parts = [p for p in u.path.split("/") if p]
        vid = parts[0] if parts else None
    elif u.path == "/watch":
        vals = parse_qs(u.query).get("v")
        vid = vals[0] if vals else None
    else:
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("live", "shorts", "embed", "v"):
            vid = parts[1]
    if not vid or not ID_RE.match(vid):
        raise bad
    return vid, f"https://www.youtube.com/watch?v={vid}"


def base_args() -> list[str]:
    args = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--no-color",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--cache-dir",
        str(DATA_DIR / "ytcache"),
    ]
    if PROXY_URL:
        args += ["--proxy", PROXY_URL]
    if COOKIES_PATH:
        args += ["--cookies", str(COOKIES_PATH)]
    return args


def fetch_info(url: str) -> dict:
    cmd = base_args() + ["-J", "--skip-download", url]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=INFO_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise ApiError("UPSTREAM_TIMEOUT", "YouTube took too long to respond. Try again.", 504)
    if p.returncode != 0:
        raise map_error(p.stderr or p.stdout)
    try:
        return json.loads(p.stdout)
    except ValueError:
        raise ApiError("INTERNAL", "Could not read video details. Try again.", 500)


def summarize(data: dict, vid: str) -> dict:
    heights = set()
    for f in data.get("formats") or []:
        h = f.get("height")
        if isinstance(h, int) and f.get("vcodec") not in (None, "none"):
            heights.add(h)
    max_h = max(heights) if heights else 0
    avail = [h for h in ALLOWED_HEIGHTS if h <= max_h]
    if not avail and max_h > 0:
        avail = [ALLOWED_HEIGHTS[-1]]
    duration = data.get("duration")
    is_live = bool(data.get("is_live")) or data.get("live_status") in ("is_live", "is_upcoming")
    return {
        "videoId": vid,
        "title": str(data.get("title") or "Untitled"),
        "channel": str(data.get("channel") or data.get("uploader") or ""),
        "duration": int(duration) if isinstance(duration, (int, float)) else None,
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "isLive": is_live,
        "heights": avail,
        "limits": {"maxSecondsUhd": MAX_SECONDS_UHD, "maxSecondsHd": MAX_SECONDS_HD},
    }


def check_auth(secret: Optional[str]) -> None:
    if not secret or not hmac.compare_digest(secret.encode(), WORKER_SECRET.encode()):
        raise ApiError("UNAUTHORIZED", "Unauthorized.", 401)


def sign(job_id: str, exp: int) -> str:
    msg = f"{job_id}.{exp}".encode()
    return hmac.new(WORKER_SECRET.encode(), msg, hashlib.sha256).hexdigest()


def fmt_len(seconds: int) -> str:
    m, s = divmod(seconds, 60)
    return f"{m} min {s} s" if s else f"{m} min"


def validate_range(start: int, end: int, height: int, duration: Optional[int]) -> None:
    if start < 0 or end <= start:
        raise ApiError("RANGE_INVALID", "End time must be after start time.", 400)
    if duration is not None and end > duration + 1:
        raise ApiError("RANGE_INVALID", "End time is past the end of the video.", 400)
    cap = MAX_SECONDS_UHD if height >= 1440 else MAX_SECONDS_HD
    if end - start > cap:
        raise ApiError("TOO_LONG", f"Clips at this quality can be up to {fmt_len(cap)} long.", 400)


# ---------------------------------------------------------------- state

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
RATE: dict[str, list[float]] = {}
RATE_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_CONCURRENT)


def update_job(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job.update(fields)


def rate_check(ip: str) -> None:
    now = time.time()
    with RATE_LOCK:
        hits = [t for t in RATE.get(ip, []) if now - t < 3600]
        RATE[ip] = hits
        if len(hits) >= MAX_JOBS_PER_HOUR:
            raise ApiError("RATE_LIMITED", "Hourly clip limit reached. Try again later.", 429)
    with JOBS_LOCK:
        if any(j["ip"] == ip and j["status"] in ACTIVE for j in JOBS.values()):
            raise ApiError("RATE_LIMITED", "You already have a clip in progress. Wait for it to finish.", 429)


def rate_record(ip: str) -> None:
    with RATE_LOCK:
        RATE.setdefault(ip, []).append(time.time())


LIB_LOCK = threading.Lock()


def load_index() -> list[dict]:
    """Call with LIB_LOCK held."""
    try:
        data = json.loads(INDEX_PATH.read_text())
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_index(items: list[dict]) -> None:
    """Call with LIB_LOCK held. Atomic replace."""
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(items))
    os.replace(tmp, INDEX_PATH)


# ---------------------------------------------------------------- job runner


def run_job(
    job_id: str, vid: str, url: str, start: int, end: int, height: int, container: str, meta: dict, save: bool
) -> None:
    job_dir = JOBS_DIR / job_id
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        update_job(job_id, status="fetching", progress=1)

        cmd = base_args() + [
            "--newline",
            "--download-sections",
            f"*{start}-{end}",
            "--force-keyframes-at-cuts",
            "-f",
            f"bv*[height<={height}]+ba/b[height<={height}]",
            "--merge-output-format",
            "mkv",
            "-o",
            str(job_dir / "clip.%(ext)s"),
            url,
        ]
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
        timer = threading.Timer(JOB_TIMEOUT, proc.kill)
        timer.start()
        tail: list[str] = []
        clip_len = max(1, end - start)
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                tail.append(line)
                tail = tail[-60:]
                m = PCT_RE.search(line)
                if m:
                    update_job(job_id, progress=min(70.0, float(m.group(1)) * 0.7))
                    continue
                t = TIME_RE.search(line)
                if t:
                    secs = int(t.group(1)) * 3600 + int(t.group(2)) * 60 + float(t.group(3))
                    update_job(job_id, progress=min(70.0, secs / clip_len * 70.0))
            proc.wait()
        finally:
            timer.cancel()

        if proc.returncode != 0:
            if proc.returncode < 0:
                raise ApiError("TIMEOUT", "The clip took too long and was cancelled. Try a shorter range.", 504)
            raise map_error("".join(tail))

        files = [
            p
            for p in job_dir.iterdir()
            if p.is_file() and p.name.startswith("clip") and p.suffix not in (".part", ".ytdl")
        ]
        if not files:
            raise ApiError("INTERNAL", "No output was produced. Try again.", 500)
        src = max(files, key=lambda p: p.stat().st_size)

        if container == "mp4":
            update_job(job_id, status="converting", progress=75)
            out = job_dir / "final.mp4"
            ff = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(src),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                str(out),
            ]
            r = subprocess.run(ff, capture_output=True, text=True, timeout=JOB_TIMEOUT)
            if r.returncode != 0:
                log.warning("ffmpeg failed: %s", r.stderr[-1500:])
                raise ApiError("CONVERT_FAILED", "Could not convert the clip to MP4. Try MKV instead.", 500)
            src.unlink(missing_ok=True)
            final = out
        else:
            final = src

        ext = final.suffix.lstrip(".") or "mkv"
        name = f"clip_{vid}_{start}-{end}_{height}p.{ext}"
        file_path = final
        if save:
            lib_dir = LIB_DIR / job_id
            lib_dir.mkdir(parents=True, exist_ok=True)
            dest = lib_dir / name
            shutil.move(str(final), str(dest))
            entry = {
                "id": job_id,
                "title": meta.get("title", "Untitled"),
                "channel": meta.get("channel", ""),
                "videoId": vid,
                "start": start,
                "end": end,
                "height": height,
                "container": ext,
                "filename": name,
                "size": dest.stat().st_size,
                "createdAt": time.time(),
            }
            with LIB_LOCK:
                items = load_index()
                items.append(entry)
                save_index(items)
            file_path = dest
        update_job(
            job_id,
            status="done",
            progress=100,
            file=str(file_path),
            filename=name,
            saved=save,
            finished=time.time(),
        )
    except ApiError as e:
        update_job(job_id, status="error", error={"code": e.code, "message": e.message})
    except subprocess.TimeoutExpired:
        update_job(
            job_id,
            status="error",
            error={"code": "TIMEOUT", "message": "Conversion took too long. Try a shorter range."},
        )
    except Exception:  # noqa: BLE001
        log.exception("Job %s crashed", job_id)
        update_job(
            job_id,
            status="error",
            error={"code": "INTERNAL", "message": "Something went wrong. Try again."},
        )


def cleanup_loop() -> None:
    while True:
        time.sleep(300)
        try:
            now = time.time()
            with JOBS_LOCK:
                old = [jid for jid, j in JOBS.items() if now - j["created"] > FILE_TTL and j["status"] not in ACTIVE]
                for jid in old:
                    JOBS.pop(jid, None)
            for jid in old:
                shutil.rmtree(JOBS_DIR / jid, ignore_errors=True)
            with RATE_LOCK:
                for ip in list(RATE):
                    RATE[ip] = [t for t in RATE[ip] if now - t < 3600]
                    if not RATE[ip]:
                        RATE.pop(ip, None)
        except Exception:  # noqa: BLE001
            log.exception("cleanup failed")


# ---------------------------------------------------------------- app


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Wipe leftovers from a previous run (job state is in memory only).
    for p in JOBS_DIR.iterdir():
        shutil.rmtree(p, ignore_errors=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(ApiError)
async def _api_error(_: Request, exc: ApiError):
    return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    return JSONResponse(
        {"error": {"code": "INVALID_REQUEST", "message": "Invalid request."}}, status_code=400
    )


class InfoReq(BaseModel):
    url: str


class JobReq(BaseModel):
    url: str
    start: int
    end: int
    height: int
    container: Literal["mp4", "mkv"]
    attested: bool
    save: bool = False


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/info")
def info(req: InfoReq, x_worker_secret: Optional[str] = Header(None)):
    check_auth(x_worker_secret)
    vid, url = canonical_url(req.url)
    return summarize(fetch_info(url), vid)


@app.post("/jobs")
def create_job(
    req: JobReq,
    x_worker_secret: Optional[str] = Header(None),
    x_client_ip: Optional[str] = Header(None),
):
    check_auth(x_worker_secret)
    if not req.attested:
        raise ApiError("ATTESTATION_REQUIRED", "Confirm you own this video or have permission to clip it.", 400)
    if req.height not in ALLOWED_HEIGHTS:
        raise ApiError("INVALID_REQUEST", "Pick a quality from the list.", 400)
    vid, url = canonical_url(req.url)
    validate_range(req.start, req.end, req.height, None)

    ip = (x_client_ip or "unknown")[:64]
    rate_check(ip)

    summary = summarize(fetch_info(url), vid)
    if summary["isLive"]:
        raise ApiError("LIVE_IN_PROGRESS", "This stream hasn't ended yet. Try again once it has.", 409)
    if not summary["heights"]:
        raise ApiError("NO_FORMATS", "No downloadable video formats were found.", 422)
    validate_range(req.start, req.end, req.height, summary["duration"])

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "error": None,
            "file": None,
            "filename": None,
            "ip": ip,
            "created": time.time(),
            "finished": None,
            "saved": False,
        }
    rate_record(ip)
    EXECUTOR.submit(
        run_job,
        job_id, vid, url, req.start, req.end, req.height, req.container,
        {"title": summary["title"], "channel": summary["channel"]},
        req.save,
    )
    return {"jobId": job_id}


@app.get("/jobs/{job_id}")
def job_status(job_id: str, x_worker_secret: Optional[str] = Header(None)):
    check_auth(x_worker_secret)
    if not JOB_ID_RE.match(job_id):
        raise ApiError("NOT_FOUND", "Clip job not found.", 404)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        snap = dict(job) if job else None
    if not snap:
        raise ApiError("NOT_FOUND", "Clip job not found or expired. Start a new clip.", 404)

    out: dict = {
        "status": snap["status"],
        "progress": round(float(snap["progress"]), 1),
    }
    if snap["status"] == "error":
        out["error"] = snap["error"]
    if snap["status"] == "done":
        if not snap["file"] or not Path(snap["file"]).is_file():
            out["status"] = "error"
            out["error"] = {"code": "EXPIRED", "message": "This clip has expired. Start a new one."}
        else:
            exp = int(time.time()) + LINK_TTL
            out["filename"] = snap["filename"]
            out["saved"] = bool(snap.get("saved"))
            out["downloadPath"] = f"/download/{job_id}?exp={exp}&sig={sign(job_id, exp)}"
    return out


@app.get("/download/{job_id}")
def download(job_id: str, exp: int, sig: str):
    if not JOB_ID_RE.match(job_id):
        raise ApiError("NOT_FOUND", "File not found.", 404)
    if exp < time.time():
        raise ApiError("LINK_EXPIRED", "This download link has expired.", 410)
    if not hmac.compare_digest(sign(job_id, exp), sig):
        raise ApiError("FORBIDDEN", "Invalid download link.", 403)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        snap = dict(job) if job else None
    if not snap or snap["status"] != "done" or not snap["file"] or not Path(snap["file"]).is_file():
        raise ApiError("NOT_FOUND", "File not found or expired.", 404)
    media = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
    }.get(Path(snap["file"]).suffix.lower(), "application/octet-stream")
    return FileResponse(snap["file"], filename=snap["filename"], media_type=media)


# ---------------------------------------------------------------- library

LIB_FIELDS = ("id", "title", "channel", "videoId", "start", "end", "height", "container", "filename", "size", "createdAt")


def lib_file(entry: dict) -> Path:
    return LIB_DIR / entry["id"] / entry["filename"]


@app.get("/library")
def library_list(x_worker_secret: Optional[str] = Header(None)):
    check_auth(x_worker_secret)
    with LIB_LOCK:
        items = load_index()
    items = [e for e in items if JOB_ID_RE.match(str(e.get("id", ""))) and lib_file(e).is_file()]
    items.sort(key=lambda e: e.get("createdAt", 0), reverse=True)
    exp = int(time.time()) + LINK_TTL
    out = []
    for e in items:
        row = {k: e.get(k) for k in LIB_FIELDS}
        row["downloadPath"] = f"/library/{e['id']}/download?exp={exp}&sig={sign('lib-' + e['id'], exp)}"
        out.append(row)
    return {"items": out}


@app.delete("/library/{lib_id}")
def library_delete(lib_id: str, x_worker_secret: Optional[str] = Header(None)):
    check_auth(x_worker_secret)
    if not JOB_ID_RE.match(lib_id):
        raise ApiError("NOT_FOUND", "Clip not found.", 404)
    with LIB_LOCK:
        items = load_index()
        kept = [e for e in items if e.get("id") != lib_id]
        if len(kept) == len(items):
            raise ApiError("NOT_FOUND", "Clip not found.", 404)
        save_index(kept)
    shutil.rmtree(LIB_DIR / lib_id, ignore_errors=True)
    return {"ok": True}


@app.get("/library/{lib_id}/download")
def library_download(lib_id: str, exp: int, sig: str):
    if not JOB_ID_RE.match(lib_id):
        raise ApiError("NOT_FOUND", "File not found.", 404)
    if exp < time.time():
        raise ApiError("LINK_EXPIRED", "This download link has expired. Reload the page.", 410)
    if not hmac.compare_digest(sign("lib-" + lib_id, exp), sig):
        raise ApiError("FORBIDDEN", "Invalid download link.", 403)
    with LIB_LOCK:
        entry = next((e for e in load_index() if e.get("id") == lib_id), None)
    if not entry or not lib_file(entry).is_file():
        raise ApiError("NOT_FOUND", "File not found.", 404)
    media = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
    }.get(lib_file(entry).suffix.lower(), "application/octet-stream")
    return FileResponse(str(lib_file(entry)), filename=entry["filename"], media_type=media)
