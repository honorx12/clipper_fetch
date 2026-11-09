import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { callWorker, clientIp, errorResponse, readJson } from '@/lib/worker';
import { extractVideoId } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const CONTAINERS = ['mp4', 'mkv'];

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return errorResponse('ADMIN_REQUIRED', 'Log in as admin to create clips.', 401);
  }
  const body = await readJson(req);
  if (!body) return errorResponse('INVALID_REQUEST', 'Invalid request.', 400);

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || url.length > 300 || !extractVideoId(url)) {
    return errorResponse('INVALID_URL', 'Paste a YouTube video, live-stream or Shorts link.', 400);
  }

  const start = Number(body.start);
  const end = Number(body.end);
  const height = Number(body.height);
  const container = typeof body.container === 'string' ? body.container : '';

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return errorResponse('RANGE_INVALID', 'End time must be after start time.', 400);
  }
  if (!HEIGHTS.includes(height)) {
    return errorResponse('INVALID_REQUEST', 'Pick a quality from the list.', 400);
  }
  if (!CONTAINERS.includes(container)) {
    return errorResponse('INVALID_REQUEST', 'Pick MP4 or MKV.', 400);
  }
  if (body.attested !== true) {
    return errorResponse(
      'ATTESTATION_REQUIRED',
      'Confirm you own this video or have permission to clip it.',
      400,
    );
  }

  const result = await callWorker('/jobs', {
    method: 'POST',
    body: {
      url,
      start: Math.floor(start),
      end: Math.ceil(end),
      height,
      container,
      attested: true,
      save: true,
    },
    ip: clientIp(req),
    timeoutMs: 40000,
  });
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result.data, { status: result.status });
}
