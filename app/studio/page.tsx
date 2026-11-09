'use client';

import { useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import Link from 'next/link';
import { extractVideoId, formatTime, parseTime } from '@/lib/time';

type Info = {
  videoId: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  isLive: boolean;
  heights: number[];
  limits: { maxSecondsUhd: number; maxSecondsHd: number };
};

type JobState = {
  status: 'queued' | 'fetching' | 'converting' | 'done' | 'error';
  progress: number;
  downloadUrl?: string;
  filename?: string;
  saved?: boolean;
  error?: { code: string; message: string };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Network error. Check your connection and try again.');
  }
  let data: { error?: { message?: string } } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Request failed (${res.status}). Try again.`);
  }
  return data as unknown as T;
}

function qualityLabel(h: number): string {
  if (h === 2160) return '4K (2160p)';
  if (h === 1440) return '2K (1440p)';
  return `${h}p`;
}

function TimeField(props: { label: string; value: number; onCommit: (n: number) => void }) {
  const { label, value, onCommit } = props;
  const [text, setText] = useState(formatTime(value));
  const [bad, setBad] = useState(false);

  useEffect(() => {
    setText(formatTime(value));
    setBad(false);
  }, [value]);

  const commit = () => {
    const n = parseTime(text);
    if (n === null) {
      setBad(true);
      return;
    }
    setBad(false);
    onCommit(n);
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        className={bad ? 'time bad' : 'time'}
        value={text}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={bad}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

function Tool() {
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [info, setInfo] = useState<Info | null>(null);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(30);
  const [preview, setPreview] = useState(false);

  const [height, setHeight] = useState(0);
  const [container, setContainer] = useState<'mp4' | 'mkv'>('mp4');
  const [attested, setAttested] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);

  const duration = info?.duration ?? 0;
  const cap = info ? (height >= 1440 ? info.limits.maxSecondsUhd : info.limits.maxSecondsHd) : 0;
  const length = end - start;
  const lengthOk = length >= 1 && length <= cap;
  const canCreate = !!info && !info.isLive && height > 0 && attested && lengthOk && !creating && !jobId;
  const working = !!jobId && job?.status !== 'done' && job?.status !== 'error';

  // Poll job status
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let failures = 0;

    const tick = async () => {
      try {
        const next = await api<JobState>(`/api/jobs/${jobId}`);
        failures = 0;
        if (stopped) return;
        setJob(next);
        if (next.status === 'done' || next.status === 'error') {
          stopped = true;
          window.clearInterval(timer);
        }
      } catch (e) {
        failures += 1;
        if (failures >= 5 && !stopped) {
          stopped = true;
          window.clearInterval(timer);
          setJob({
            status: 'error',
            progress: 0,
            error: { code: 'NETWORK', message: e instanceof Error ? e.message : 'Lost connection to the server.' },
          });
        }
      }
    };

    const timer = window.setInterval(tick, 2000);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId]);

  const setRange = (s: number, e: number) => {
    setStart(s);
    setEnd(e);
    setPreview(false);
  };

  const checkLink = async () => {
    setLinkError('');
    if (!extractVideoId(url)) {
      setLinkError('Paste a YouTube video, live-stream or Shorts link.');
      return;
    }
    setChecking(true);
    setInfo(null);
    setJobId(null);
    setJob(null);
    setCreateError('');
    setAttested(false);
    setPreview(false);
    try {
      const data = await api<Info>('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      setInfo(data);
      const d = data.duration ?? 0;
      setStart(0);
      setEnd(Math.max(1, Math.min(d || 30, 30)));
      setHeight(data.heights[0] ?? 0);
      if (data.isLive) setLinkError('This stream is still live. Come back once it has ended.');
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : 'Could not check that link.');
    } finally {
      setChecking(false);
    }
  };

  const createClip = async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateError('');
    try {
      const data = await api<{ jobId: string }>('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), start, end, height, container, attested }),
      });
      setJob({ status: 'queued', progress: 0 });
      setJobId(data.jobId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not start the clip.');
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setJob(null);
    setCreateError('');
  };

  const pct = (n: number) => (duration > 0 ? (n / duration) * 100 : 0);
  const statusText: Record<JobState['status'], string> = {
    queued: 'Waiting for a free slot…',
    fetching: 'Downloading your segment…',
    converting: 'Converting to MP4…',
    done: 'Clip ready.',
    error: 'Clip failed.',
  };

  return (
    <>
      <header className="hero">
        <h1>Cut the part you need.</h1>
        <p>Paste a YouTube link, mark the start and end. Finished clips are saved to the shared library.</p>
      </header>

      <section className="panel" aria-labelledby="s1">
        <h2 id="s1">1. Paste the link</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            checkLink();
          }}
        >
          <input
            className="url"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="YouTube link"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn primary" type="submit" disabled={checking || !url.trim()}>
            {checking ? 'Checking…' : 'Check link'}
          </button>
        </form>
        {linkError && (
          <p className="msg error" role="alert">
            {linkError}
          </p>
        )}

        {info && (
          <div className="video">
            {info.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={info.thumbnail} alt="" width={160} height={90} />
            ) : (
              <div className="thumb-empty" />
            )}
            <div>
              <strong>{info.title}</strong>
              <div className="muted">
                {info.channel}
                {info.duration ? ` · ${formatTime(info.duration)} long` : ''}
              </div>
            </div>
          </div>
        )}
      </section>

      {info && !info.isLive && duration > 0 && (
        <section className="panel" aria-labelledby="s2">
          <h2 id="s2">2. Mark the range</h2>

          <div className="range">
            <div className="track" />
            <div className="sel" style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }} />
            <input
              type="range"
              min={0}
              max={duration}
              step={1}
              value={start}
              aria-label="Start time"
              onChange={(e) => setRange(Math.min(Number(e.target.value), end - 1), end)}
              disabled={!!jobId}
            />
            <input
              type="range"
              min={0}
              max={duration}
              step={1}
              value={end}
              aria-label="End time"
              onChange={(e) => setRange(start, Math.max(Number(e.target.value), start + 1))}
              disabled={!!jobId}
            />
          </div>

          <div className="row times">
            <TimeField label="Start" value={start} onCommit={(n) => setRange(Math.max(0, Math.min(n, end - 1)), end)} />
            <TimeField
              label="End"
              value={end}
              onCommit={(n) => setRange(start, Math.min(duration, Math.max(n, start + 1)))}
            />
            <div className="field">
              <span>Length</span>
              <div className={lengthOk ? 'readout' : 'readout bad'}>{formatTime(Math.max(0, length))}</div>
            </div>
          </div>
          {!lengthOk && cap > 0 && (
            <p className="msg error" role="alert">
              Clips at {qualityLabel(height)} can be up to {formatTime(cap)} long. Shorten the range or lower the quality.
            </p>
          )}

          <button className="btn" type="button" onClick={() => setPreview((p) => !p)} disabled={!!jobId}>
            {preview ? 'Hide preview' : 'Preview this range'}
          </button>
          {preview && (
            <div className="player">
              <iframe
                title="Preview of the selected range"
                src={`https://www.youtube-nocookie.com/embed/${info.videoId}?start=${start}&end=${end}&rel=0`}
                allow="encrypted-media; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}
        </section>
      )}

      {info && !info.isLive && duration > 0 && (
        <section className="panel" aria-labelledby="s3">
          <h2 id="s3">3. Choose the output</h2>

          {info.heights.length === 0 ? (
            <p className="msg error" role="alert">
              No downloadable video formats were found for this link.
            </p>
          ) : (
            <div className="row">
              <label className="field">
                <span>Quality</span>
                <select value={height} onChange={(e) => setHeight(Number(e.target.value))} disabled={!!jobId}>
                  {info.heights.map((h) => (
                    <option key={h} value={h}>
                      {qualityLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Format</span>
                <select
                  value={container}
                  onChange={(e) => setContainer(e.target.value === 'mkv' ? 'mkv' : 'mp4')}
                  disabled={!!jobId}
                >
                  <option value="mp4">MP4 — plays everywhere, slower</option>
                  <option value="mkv">MKV — original quality, faster</option>
                </select>
              </label>
            </div>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              disabled={!!jobId}
            />
            <span>
              I own this video, have the owner&rsquo;s permission, or it carries a license that allows reuse.
            </span>
          </label>

          <button className="btn primary big" type="button" onClick={createClip} disabled={!canCreate}>
            {creating ? 'Starting…' : 'Create clip'}
          </button>
          {createError && (
            <p className="msg error" role="alert">
              {createError}
            </p>
          )}

          {jobId && job && (
            <div className="job" aria-live="polite">
              <div className="job-head">
                <span>{job.status === 'error' ? 'Clip failed' : statusText[job.status]}</span>
                {job.status !== 'error' && <span className="mono">{Math.round(job.progress)}%</span>}
              </div>
              <div className="bar" aria-hidden="true">
                <div
                  className={job.status === 'error' ? 'fill bad' : 'fill'}
                  style={{ width: `${job.status === 'done' ? 100 : Math.max(3, job.progress)}%` }}
                />
              </div>

              {job.status === 'error' && (
                <p className="msg error" role="alert">
                  {job.error?.message ?? 'Something went wrong. Try again.'}
                </p>
              )}

              {job.status === 'done' && job.downloadUrl && (
                <div className="row">
                  <a className="btn primary big" href={job.downloadUrl} download={job.filename}>
                    Download clip
                  </a>
                  <span className="muted">
                    {job.saved ? (
                      <>
                        Saved to the <Link href="/">library</Link>.
                      </>
                    ) : (
                      'Download within an hour; the file is then deleted.'
                    )}
                  </span>
                </div>
              )}

              {!working && (
                <button className="btn" type="button" onClick={reset}>
                  {job.status === 'done' ? 'Make another clip from this video' : 'Try again'}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        Only clip videos you have the right to use. Downloading other people&rsquo;s videos may break YouTube&rsquo;s
        Terms of Service and copyright law.
      </footer>
    </>
  );
}

export default function Studio() {
  const [auth, setAuth] = useState<'loading' | 'out' | 'in' | 'unconfigured'>('loading');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ admin: boolean; configured: boolean }>('/api/admin/session')
      .then((d) => setAuth(!d.configured ? 'unconfigured' : d.admin ? 'in' : 'out'))
      .catch(() => setAuth('out'));
  }, []);

  const login = async () => {
    setBusy(true);
    setError('');
    try {
      await api<{ admin: boolean }>('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      setPassword('');
      setAuth('in');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api<{ admin: boolean }>('/api/admin/logout', { method: 'POST' });
    } catch {
      // ignore: cookie expires on its own
    }
    setAuth('out');
  };

  return (
    <main className="wrap">
      <Nav current="studio" />
      {auth === 'loading' && <p className="muted">Loading…</p>}

      {auth === 'unconfigured' && (
        <section className="panel">
          <h2>Admin login is not set up</h2>
          <p className="msg error">Set the ADMIN_PASSWORD environment variable on Vercel, then redeploy.</p>
        </section>
      )}

      {auth === 'out' && (
        <section className="panel" aria-labelledby="login">
          <h2 id="login">Admin login</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              login();
            }}
          >
            <label className="field grow">
              <span>Password</span>
              <input
                className="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Log in'}
            </button>
          </form>
          {error && (
            <p className="msg error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      {auth === 'in' && (
        <>
          <Tool />
          <p className="foot">
            <button className="linkbtn" type="button" onClick={logout}>
              Log out
            </button>
          </p>
        </>
      )}
    </main>
  );
}
