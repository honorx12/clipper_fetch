# ClipFetch

**Full step-by-step guide: see `SETUP.md`.**

Admin pastes a YouTube link → picks start/end → clip is saved to a shared **library**, grouped by day.
Anyone with the site link opens the library and downloads clips in the quality they were saved at (4K if you picked 4K).

- `/` — library behind a shared viewer password (newest day first, Play for MP4, **Download 4K UHD**)
- `/studio` — admin only: create clips (password), delete clips from the library

```
Browser ──► Vercel (Next.js UI + /api/* proxy) ──► Worker (Docker: FastAPI + yt-dlp + ffmpeg)
                                                      └─ browser downloads file directly via signed link
```

Vercel can't run yt-dlp/ffmpeg (time, size, body limits), so the heavy work lives in `worker/`.

## 1. Deploy the worker (Railway shown; Fly.io / any Docker VPS works the same)

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub → set **Root Directory** = `worker` (it builds `worker/Dockerfile`).
3. **Add a Volume** (Railway → service → Volumes) mounted at `/data`. Size it for your clips (a 5-min 4K clip ≈ 0.3–1 GB). Without a volume, the library is lost on every redeploy.
4. Variables:
   - `DATA_DIR` = `/data`
   - `WORKER_SECRET` = long random string (32+ chars). Generate: `openssl rand -hex 32`
   - optional: see `.env.example` (`MAX_SECONDS_UHD`, `MAX_CONCURRENT`, `YTDLP_COOKIES_B64`, `PROXY_URL`…)
5. Settings → Networking → Generate Domain. Check `https://<domain>/health` → `{"ok":true}`.
6. Size: 4K→MP4 needs ≥ 4 vCPU / 8 GB RAM. Keep **one instance** (job state is in memory).

## 2. Deploy the frontend on Vercel

1. Vercel → Add New Project → import the repo. Root Directory = repo root. Framework = Next.js (auto).
2. Environment variables:
   - `WORKER_URL` = `https://<your worker domain>` (no trailing slash)
   - `WORKER_SECRET` = same value as the worker
   - `ADMIN_PASSWORD` = password you type at `/studio`
   - `VIEWER_PASSWORD` = password you give to viewers (e.g. `lendi_praggy`)
3. Deploy. `worker/` is excluded via `.vercelignore`.

## Local dev

```bash
# worker
cd worker
docker build -t clipfetch-worker .
docker run --rm -p 8080:8080 -e WORKER_SECRET=dev-secret-dev-secret-1234 clipfetch-worker

# frontend (new terminal, repo root)
npm install            # also creates package-lock.json — commit it
cp .env.example .env.local   # set WORKER_URL=http://localhost:8080 and the same WORKER_SECRET
npm run dev            # http://localhost:3000
```

## If something fails

| Message | Cause | Fix |
|---|---|---|
| `Server is not configured yet` | Vercel env vars missing | Set `WORKER_URL`, `WORKER_SECRET`, redeploy |
| `Cannot reach the clip server` | Worker down / wrong URL | Check worker logs + `/health` |
| `Admin login is not set up` | `ADMIN_PASSWORD` missing | Add on Vercel, redeploy |
| Library empty after redeploy | No volume on worker | Mount volume at `/data`, set `DATA_DIR=/data` |
| `This download link has expired` | Link older than 1 h | Reload the library page |
| `Unauthorized` | Secrets differ | Make both `WORKER_SECRET` identical |
| `YouTube is blocking the server` | Datacenter IP flagged | Add `YTDLP_COOKIES_B64` and/or `PROXY_URL`; redeploy |
| Downloads suddenly fail everywhere | YouTube changed | Redeploy worker (rebuild pulls newest yt-dlp) |

## Limits (change via worker env)

4K/2K clips ≤ 5 min, lower qualities ≤ 15 min, 5 clips/hour/IP, 1 active clip per IP. Library clips stay until you delete them; temp files are deleted after 2 h.
One file per clip (the quality you chose). To offer several qualities, create the clip once per quality.

## Legal

YouTube's Terms forbid downloading except through YouTube's own features, and copyright applies. Use only for
videos you own, have permission for, or that carry a reuse license. The UI requires an attestation checkbox.
