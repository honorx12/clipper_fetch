import { NextRequest, NextResponse } from 'next/server';
import { callWorker, clientIp, errorResponse, workerBase } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ID_RE = /^[a-f0-9]{32}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_RE.test(id)) {
    return errorResponse('NOT_FOUND', 'Clip job not found.', 404);
  }

  const result = await callWorker(`/jobs/${id}`, {
    method: 'GET',
    ip: clientIp(req),
    timeoutMs: 20000,
  });
  if (result instanceof NextResponse) return result;

  const data = { ...result.data };
  const path = data.downloadPath;
  delete data.downloadPath;
  if (typeof path === 'string' && path.startsWith('/download/')) {
    const base = workerBase();
    if (base) data.downloadUrl = `${base}${path}`;
  }
  return NextResponse.json(data, { status: result.status });
}