import { NextResponse } from 'next/server';
import { getSecuritySettings, verifyPin } from '@/lib/security/security-store';
import { isIpAllowed } from '@/domain/security/types';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import { readJson } from '@/lib/mock-backend/result-http';

/**
 * POST /api/kiosk/authorize — PIN / IP による受付端末の初回許可 (issue #23)。
 * 許可後は長期 kiosk session cookie を発行し、リロード/再起動後も受付画面に復帰できる。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { pin?: unknown; kioskId?: unknown } | null;
  const settings = await getSecuritySettings();
  const clientIp = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';

  if (!isIpAllowed(clientIp, settings.ipAllowlist)) {
    return NextResponse.json({ error: 'forbidden', message: 'ip not allowed' }, { status: 403 });
  }
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  if (!(await verifyPin(pin))) {
    return NextResponse.json({ error: 'unauthorized', message: 'invalid pin' }, { status: 401 });
  }

  const kioskId = typeof body?.kioskId === 'string' && body.kioskId ? body.kioskId : 'kiosk-dev';
  const token = await issueKioskSession(kioskId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(KIOSK_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: Math.floor(KIOSK_SESSION_TTL_MS / 1000),
  });
  return res;
}
