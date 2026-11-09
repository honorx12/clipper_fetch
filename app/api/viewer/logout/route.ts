import { NextResponse } from 'next/server';
import { VIEWER_COOKIE } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ viewer: false });
  res.cookies.set(VIEWER_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
