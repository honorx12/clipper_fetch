import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { callWorker, clientIp, errorResponse, readJson } from '@/lib/worker';
import { extractVideoId } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return errorResponse('ADMIN_REQUIRED', 'Log in as admin to create clips.', 401);
  }
  const body = await readJson(req);
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url || url.length > 300 || !extractVideoId(url)) {
    return errorResponse('INVALID_URL', 'Paste a YouTube video, live-stream or Shorts link.', 400);
  }

  const result = await callWorker('/info', {
    method: 'POST',
    body: { url },
    ip: clientIp(req),
    timeoutMs: 40000,
  });
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result.data, { status: result.status });
}
