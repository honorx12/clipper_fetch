import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  COOKIE_MAX_AGE,
  adminConfigured,
  checkPassword,
  makeToken,
  recordFailure,
  tooManyAttempts,
} from '@/lib/admin';
import { clientIp, errorResponse, readJson } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!adminConfigured()) {
    return errorResponse('MISCONFIGURED', 'Admin login is not set up. Set ADMIN_PASSWORD on the server.', 500);
  }
  const ip = clientIp(req);
  if (tooManyAttempts(ip)) {
    return errorResponse('RATE_LIMITED', 'Too many wrong passwords. Try again in 15 minutes.', 429);
  }
  const body = await readJson(req);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password || password.length > 200 || !checkPassword(password)) {
    recordFailure(ip);
    await new Promise((r) => setTimeout(r, 800));
    return errorResponse('BAD_PASSWORD', 'Wrong password.', 401);
  }
  const token = makeToken();
  if (!token) return errorResponse('MISCONFIGURED', 'Admin login is not set up.', 500);

  const res = NextResponse.json({ admin: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
