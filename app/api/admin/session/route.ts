import { NextRequest, NextResponse } from 'next/server';
import { adminConfigured, isAdmin, isViewer, viewerConfigured } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return NextResponse.json({
    admin: isAdmin(req),
    viewer: isViewer(req),
    configured: adminConfigured(),
    viewerConfigured: viewerConfigured(),
  });
}
