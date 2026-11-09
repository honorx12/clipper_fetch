'use client';

import { useCallback, useEffect, useState } from 'react';
import Nav from '@/components/Nav';
import { formatTime } from '@/lib/time';

type Item = {
  id: string;
  title: string;
  channel: string;
  videoId: string;
  start: number;
  end: number;
  height: number;
  container: string;
  filename: string;
  size: number;
  createdAt: number;
  downloadUrl?: string;
};

function qualityLabel(h: number): string {
  if (h === 2160) return '4K';
  if (h === 1440) return '2K';
  return `${h}p`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function dayLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function Library() {
  const [gate, setGate] = useState<'loading' | 'out' | 'in' | 'unconfigured'>('loading');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [admin, setAdmin] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/library', { cache: 'no-store' });
      const data = (await res.json()) as { items?: Item[]; error?: { message?: string } };
      if (res.status === 401) {
        setGate('out');
        setItems(null);
        return;
      }
      if (!res.ok) throw new Error(data.error?.message ?? 'Could not load the library.');
      setItems(data.items ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the library.');
    }
  }, []);

  useEffect(() => {
    fetch('/api/admin/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { admin?: boolean; viewer?: boolean; viewerConfigured?: boolean }) => {
        setAdmin(!!d.admin);
        setGate(!d.viewerConfigured ? 'unconfigured' : d.viewer ? 'in' : 'out');
      })
      .catch(() => setGate('out'));
  }, []);

  useEffect(() => {
    if (gate !== 'in') return;
    load();
    // Download links expire after an hour: refresh when the tab comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [gate, load]);

  const unlock = async () => {
    setBusy(true);
    setLoginError('');
    try {
      const res = await fetch('/api/viewer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(data?.error?.message ?? 'Could not unlock the library.');
      setPassword('');
      setGate('in');
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Could not unlock the library.');
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    try {
      await fetch('/api/viewer/logout', { method: 'POST' });
    } catch {
      // cookie expires on its own
    }
    setItems(null);
    setPlaying(null);
    setGate('out');
  };

  const remove = async (item: Item) => {
    if (!window.confirm(`Delete "${item.title}" (${formatTime(item.start)}–${formatTime(item.end)}) for everyone?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/library/${item.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? 'Could not delete the clip.');
      }
      setPlaying((p) => (p === item.id ? null : p));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the clip.');
    }
  };

  const groups: { label: string; items: Item[] }[] = [];
  for (const item of items ?? []) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <main className="wrap">
      <Nav current="library" />
      <header className="hero">
        <h1>Clip library</h1>
        <p>Every clip, newest day first. Download any of them in 4K UHD, the quality they were saved at.</p>
      </header>

      {gate === 'loading' && <p className="muted">Loading…</p>}

      {gate === 'unconfigured' && (
        <section className="panel">
          <h2>Library password is not set up</h2>
          <p className="msg error">Set the VIEWER_PASSWORD environment variable on Vercel, then redeploy.</p>
        </section>
      )}

      {gate === 'out' && (
        <section className="panel" aria-labelledby="unlock">
          <h2 id="unlock">Enter the playlist password</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              unlock();
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
              {busy ? 'Checking…' : 'Open library'}
            </button>
          </form>
          {loginError && (
            <p className="msg error" role="alert">
              {loginError}
            </p>
          )}
        </section>
      )}

      {gate === 'in' && error && (
        <p className="msg error" role="alert">
          {error}
        </p>
      )}
      {gate === 'in' && !items && !error && <p className="muted">Loading clips…</p>}
      {gate === 'in' && items && items.length === 0 && !error && (
        <section className="panel">
          <h2>No clips yet</h2>
          <p className="muted">Clips appear here as soon as they are created.</p>
        </section>
      )}

      {gate === 'in' && groups.map((g) => (
        <section key={g.label} className="day" aria-label={g.label}>
          <h2>{g.label}</h2>
          <ul className="clips">
            {g.items.map((it) => (
              <li key={it.id} className="clip">
                <div className="clip-main">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg`} alt="" width={128} height={72} />
                  <div className="clip-text">
                    <strong>{it.title}</strong>
                    <div className="muted">
                      <span className="mono">
                        {formatTime(it.start)}–{formatTime(it.end)}
                      </span>{' '}
                      ({formatTime(it.end - it.start)}) · {it.channel}
                    </div>
                    <div className="meta">
                      <span className={it.height >= 2160 ? 'badge uhd' : 'badge'}>{qualityLabel(it.height)}</span>
                      <span className="badge">{it.container.toUpperCase()}</span>
                      <span className="muted">{formatSize(it.size)}</span>
                    </div>
                  </div>
                </div>

                <div className="clip-actions">
                  {it.container === 'mp4' && it.downloadUrl && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => setPlaying((p) => (p === it.id ? null : it.id))}
                    >
                      {playing === it.id ? 'Close' : 'Play'}
                    </button>
                  )}
                  {it.downloadUrl ? (
                    <a className="btn primary" href={it.downloadUrl} download={it.filename}>
                      {it.height >= 2160 ? 'Download 4K UHD' : `Download ${qualityLabel(it.height)}`}
                    </a>
                  ) : (
                    <span className="muted">Unavailable</span>
                  )}
                  {admin && (
                    <button className="btn danger" type="button" onClick={() => remove(it)}>
                      Delete
                    </button>
                  )}
                </div>

                {playing === it.id && it.downloadUrl && (
                  <div className="player wide">
                    <video src={it.downloadUrl} controls autoPlay playsInline preload="metadata" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <footer className="foot">
        Clips are provided by the site owner. Reuse is subject to the rights of the original video&rsquo;s creator.
        {gate === 'in' && (
          <>
            {' '}
            <button className="linkbtn" type="button" onClick={lock}>
              Lock library
            </button>
          </>
        )}
      </footer>
    </main>
  );
}
