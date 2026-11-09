import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { callWorker, errorResponse } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ID_RE = /^[a-f0-9]{32}$/;

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isAdmin(req)) return errorResponse('ADMIN_REQUIRED', 'Log in as admin first.', 401);
  if (!ID_RE.test(id)) return errorResponse('NOT_FOUND', 'Clip not found.', 404);

  const result = await callWorker(`/library/${id}`, { method: 'DELETE', timeoutMs: 20000 });
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result.data, { status: result.status });
}