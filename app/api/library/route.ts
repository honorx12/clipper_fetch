import { NextRequest, NextResponse } from 'next/server';
import { isViewer } from '@/lib/admin';
import { callWorker, errorResponse, workerBase } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!isViewer(req)) {
    return errorResponse('PASSWORD_REQUIRED', 'Enter the library password first.', 401);
  }
  const result = await callWorker('/library', { method: 'GET', timeoutMs: 20000 });
  if (result instanceof NextResponse) return result;
  if (result.status !== 200) return NextResponse.json(result.data, { status: result.status });

  const base = workerBase();
  const raw = Array.isArray(result.data.items) ? (result.data.items as Record<string, unknown>[]) : [];
  const items = raw.map((item) => {
    const { downloadPath, ...rest } = item;
    const downloadUrl = typeof downloadPath === 'string' && base ? `${base}${downloadPath}` : undefined;
    return { ...rest, downloadUrl };
  });
  return NextResponse.json({ items });
}
