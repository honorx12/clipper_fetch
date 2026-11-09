import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';

export type Role = 'admin' | 'viewer';

export const ADMIN_COOKIE = 'cf_admin';
export const VIEWER_COOKIE = 'cf_viewer';
export const COOKIE_MAX_AGE = 7 * 24 * 3600;
export const ADMIN_MAX_AGE = COOKIE_MAX_AGE;

const COOKIE_NAME: Record<Role, string> = { admin: ADMIN_COOKIE, viewer: VIEWER_COOKIE };
const PASSWORD_ENV: Record<Role, string> = { admin: 'ADMIN_PASSWORD', viewer: 'VIEWER_PASSWORD' };

// The signing key includes the password: changing the password instantly invalidates old cookies.
function key(role: Role): Buffer | null {
  const pw = process.env[PASSWORD_ENV[role]];
  const secret = process.env.WORKER_SECRET;
  if (!pw || !secret) return null;
  return createHash('sha256').update(`${role}:${pw}:${secret}`).digest();
}

function mac(k: Buffer, role: Role, exp: string): string {
  return createHmac('sha256', k).update(`${role}.${exp}`).digest('hex');
}

function configured(role: Role): boolean {
  return key(role) !== null;
}

function check(role: Role, input: string): boolean {
  const pw = process.env[PASSWORD_ENV[role]];
  if (!pw) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(pw).digest();
  return timingSafeEqual(a, b);
}

function make(role: Role): string | null {
  const k = key(role);
  if (!k) return null;
  const exp = String(Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE);
  return `${exp}.${mac(k, role, exp)}`;
}

function valid(req: NextRequest, role: Role): boolean {
  const k = key(role);
  if (!k) return false;
  const token = req.cookies.get(COOKIE_NAME[role])?.value;
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(mac(k, role, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const adminConfigured = () => configured('admin');
export const viewerConfigured = () => configured('viewer');
export const checkPassword = (input: string) => check('admin', input);
export const checkViewerPassword = (input: string) => check('viewer', input);
export const makeToken = () => make('admin');
export const makeViewerToken = () => make('viewer');
export const isAdmin = (req: NextRequest) => valid(req, 'admin');
/** Admins can always see the library; viewers need the shared password. */
export const isViewer = (req: NextRequest) => valid(req, 'viewer') || valid(req, 'admin');

// Basic brute-force brake (per server instance, per IP): 10 wrong tries / 15 min.
const fails = new Map<string, { n: number; reset: number }>();

export function tooManyAttempts(ip: string): boolean {
  const e = fails.get(ip);
  if (!e) return false;
  if (e.reset < Date.now()) {
    fails.delete(ip);
    return false;
  }
  return e.n >= 10;
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || e.reset < now) fails.set(ip, { n: 1, reset: now + 15 * 60 * 1000 });
  else e.n += 1;
}
