const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/** Returns the 11-char video id from a YouTube link, or null. */
export function extractVideoId(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  let id: string | null = null;
  if (host.endsWith('youtu.be')) {
    id = u.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['live', 'shorts', 'embed', 'v'].includes(parts[0])) {
      id = parts[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function formatTime(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Accepts "90", "1:30", "01:02:03". Returns seconds or null. */
export function parseTime(text: string): number | null {
  const v = text.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const parts = v.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d{1,2}$/.test(p) || (p === parts[0] && /^\d+$/.test(p)))) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.length === 2) {
    const [m, s] = nums;
    if (s > 59) return null;
    return m * 60 + s;
  }
  const [h, m, s] = nums;
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}
