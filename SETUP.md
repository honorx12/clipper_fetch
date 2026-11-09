# ClipFetch — Setup Guide

You deploy **two things**:

| Part | Where | What it does |
|---|---|---|
| Website (Next.js) | **Vercel** | Pages, login, talks to the worker |
| Worker (Docker) | **Railway** (or Fly.io / VPS) | Runs `yt-dlp` + `ffmpeg`, stores clips on a disk |

Vercel cannot run `yt-dlp`/`ffmpeg` (time + size limits). That's why the worker exists.

## How logins work

| Who | Password | Can do |
|---|---|---|
| **Viewers** (people you share the link with) | `VIEWER_PASSWORD` (yours: `lendi_praggy`) | Open library `/`, play, **download clips in 4K UHD** |
| **You (admin)** | `ADMIN_PASSWORD` (pick a different, strong one) | Everything above + `/studio` (create clips) + delete clips |

Share the site link and the viewer password. Never share the admin password.
Change a password → change the env var on Vercel → redeploy. Old logins stop working immediately.

---

## Step 0 — Accounts (all free to create)

1. GitHub — https://github.com
2. Vercel — https://vercel.com (sign in with GitHub). Hobby plan = non-commercial use only.
3. Railway — https://railway.com (sign in with GitHub). Needs a paid plan (~US$5+/mo, usage based). 4K→MP4 conversion needs a strong CPU, so expect ~US$10–30/mo.

## Step 1 — Install on your PC

- Node.js **20 LTS** — https://nodejs.org
- Git — https://git-scm.com
- VS Code (optional) — https://code.visualstudio.com

Check in a terminal: `node -v` (should print `v20.x`) and `git --version`.

## Step 2 — Unzip and test the build

```bash
unzip clipfetch.zip        # or right-click → Extract All
cd clipfetch
npm install
npm run build
```

`npm run build` must finish without errors. If it prints an error, copy it and send it to me.
`npm install` also creates `package-lock.json` — keep it.

## Step 3 — Make two secrets

Run this twice (once for each value):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- First output → **WORKER_SECRET**
- Pick your own strong **ADMIN_PASSWORD** (12+ characters, not the viewer one)

Write them down somewhere safe. Do **not** commit them to GitHub.

## Step 4 — Push to GitHub

1. On GitHub: **New repository** → name `clipfetch` → Private → Create.
2. In the `clipfetch` folder:

```bash
git init
git add .
git commit -m "ClipFetch"
git branch -M main
git remote add origin https://github.com/<your-username>/clipfetch.git
git push -u origin main
```

(`.gitignore` already blocks `.env` and `node_modules`.)

## Step 5 — Deploy the worker on Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → pick `clipfetch`.
2. Open the new service → **Settings** → **Source** → **Root Directory** = `worker`. Railway builds `worker/Dockerfile`.
3. **Add a Volume** (right-click the project canvas → Volume, attach to this service). **Mount path: `/data`**.
   This disk holds your clip library. No volume = all clips lost on every redeploy. Size: 10–50 GB to start (a 5-min 4K clip ≈ 0.3–1 GB).
4. **Variables** tab → add:

   | Name | Value |
   |---|---|
   | `WORKER_SECRET` | the secret from Step 3 |
   | `DATA_DIR` | `/data` |

   Optional: `MAX_SECONDS_UHD` (default 300), `MAX_SECONDS_HD` (default 900), `MAX_CONCURRENT` (default 1), `MAX_JOBS_PER_HOUR` (default 5).
5. **Settings → Resources**: give it as much CPU/RAM as you can afford (≥ 4 vCPU / 8 GB is comfortable for 4K).
6. **Settings → Networking → Generate Domain** (port `8080` if asked).
7. Open `https://<that-domain>/health` in a browser. You must see `{"ok":true}`.

Keep **one** instance only (job state is in memory).

## Step 6 — Deploy the website on Vercel

1. Vercel → **Add New → Project** → import `clipfetch`. Framework: Next.js (auto). Root directory: leave as repo root.
2. **Environment Variables** (before clicking Deploy):

   | Name | Value |
   |---|---|
   | `WORKER_URL` | `https://<your Railway domain>` (no trailing `/`) |
   | `WORKER_SECRET` | same value as on Railway |
   | `ADMIN_PASSWORD` | your admin password |
   | `VIEWER_PASSWORD` | `lendi_praggy` |

3. Click **Deploy**. Wait for "Congratulations".

## Step 7 — First test (use a video you own)

1. Open your Vercel URL → you see "Enter the playlist password" → type `lendi_praggy` → empty library.
2. Go to `/studio` → log in with the admin password.
3. Paste a **short video you own**. Click **Check link**.
4. Drag the handles (or type times) to pick ~15 seconds.
5. Quality: first try **1080p + MKV** (fast). Tick the permission box → **Create clip**.
6. When done, open `/` → the clip is under today's date → **Download**.
7. Then test **4K + MP4** (needs a video that has 4K, and takes longer).

## Step 8 — Share

Send people: the Vercel link + the password `lendi_praggy`.
They open the link, enter the password, see clips by day, press **Download 4K UHD**.
Download links are valid for 1 hour; reloading the page makes fresh ones.

---

## Day-to-day

- **Add clip:** `/studio` → paste → range → quality → Create.
- **Delete clip:** library → **Delete** (visible only when you're logged in as admin).
- **Clips fail suddenly for every video:** YouTube changed. Railway → worker → **Redeploy** (rebuild pulls the newest `yt-dlp`). Do this monthly anyway.
- **Disk getting full:** delete old clips or enlarge the Railway volume.
- **Backups:** the volume is the only copy. Download important clips yourself.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| "Library password is not set up" | `VIEWER_PASSWORD` missing | Add on Vercel → Redeploy |
| "Admin login is not set up" | `ADMIN_PASSWORD` or `WORKER_SECRET` missing | Add on Vercel → Redeploy |
| "Too many wrong passwords" | 10 wrong tries | Wait 15 min |
| "Server is not configured yet" | `WORKER_URL` / `WORKER_SECRET` missing | Add on Vercel → Redeploy |
| "Cannot reach the clip server" | Worker down or wrong URL | Check Railway logs and `/health`; check `WORKER_URL` |
| "Unauthorized" | Secrets differ | Make `WORKER_SECRET` identical on both |
| "YouTube is blocking the server" | YouTube flags datacenter IPs | Add `YTDLP_COOKIES_B64` (base64 of a cookies.txt from a logged-in browser) and/or `PROXY_URL` on Railway; redeploy |
| "This stream hasn't ended yet" | Live stream still running | Wait until it ends and YouTube finishes processing |
| 4K not in the quality list | The video has no 4K version | Normal; pick the highest shown |
| "Clips at this quality can be up to…" | Range too long | Shorten, or raise `MAX_SECONDS_UHD` on the worker |
| Library empty after redeploy | No volume / wrong `DATA_DIR` | Mount volume at `/data`, set `DATA_DIR=/data` |
| Download link "expired" | Link older than 1 h | Reload the library page |
| Vercel build fails | Typo / version issue | Send me the build log |

## Security notes

- `lendi_praggy` is short and guessable. For a safer playlist use 12+ random characters; change `VIEWER_PASSWORD` on Vercel and redeploy.
- Anyone with the password can download; they can also pass it on.
- Keep `.env*` files out of GitHub.
- Wrong-password tries are limited, but the limit is per server instance. It slows guessing, it doesn't stop a determined attacker.

## Legal

YouTube's Terms forbid downloading outside YouTube's own features, and the library redistributes video.
Only add videos you own or have written permission / a reuse license for. Otherwise expect takedown notices
and possible account or hosting bans.
