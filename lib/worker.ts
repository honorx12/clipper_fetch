import { NextRequest, NextResponse } from 'next/server';

export function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.slice(0, 64);
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return 'unknown';
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function workerBase(): string | null {
  const base = process.env.WORKER_URL?.trim().replace(/\/+$/, '');
  return base ? base : null;
}

type CallOptions = {
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  ip?: string;
  timeoutMs?: number;
};

/** Calls the worker and returns { status, data } or an error NextResponse. */
export async function callWorker(
  path: string,
  opts: CallOptions,
): Promise<{ status: number; data: Record<string, unknown> } | NextResponse> {
  const base = workerBase();
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) {
    return errorResponse('MISCONFIGURED', 'Server is not configured yet. Set WORKER_URL and WORKER_SECRET.', 500);
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Secret': secret,
        'X-Client-IP': opts.ip ?? 'unknown',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      return errorResponse('WORKER_BAD_RESPONSE', 'The clip server returned an unexpected response.', 502);
    }
    return { status: res.status, data: data as Record<string, unknown> };
  } catch {
    return errorResponse('WORKER_UNREACHABLE', 'Cannot reach the clip server. Try again in a minute.', 503);
  }
}
