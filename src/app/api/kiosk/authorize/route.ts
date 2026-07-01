import { NextResponse } from 'next/server';
import { getSecuritySettings, verifyPin } from '@/lib/security/security-store';
import { isIpAllowed } from '@/domain/security/types';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import { readJson } from '@/lib/mock-backend/result-http';

/**
 * POST /api/kiosk/authorize — PIN / IP による受付端末の初回許可 (issue #23)。
 * 許可後は長期 kiosk session cookie を発行し、リロード/再起動後も受付画面に復帰できる。
 *
 * PIN 必須設定時のみ有効 (issue #244)。`pinRequired=false` では PIN による自己許可を認めず 403 を返す。
 * さもないと `verifyPin` が任意 PIN で true を返し、誰でも authorize でセッションを取得できてしまい、
 * `/kiosk` セッションゲート (#239) を回避できる。IP allowlist は単独では認可根拠にしない（client 提供の
 * `x-forwarded-for` は詐称可能なため）。PIN 不要運用の端末は管理発行 URL/QR でエンロールする。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { pin?: unknown; kioskId?: unknown } | null;
  const settings = await getSecuritySettings();
  const clientIp = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';

  if (!isIpAllowed(clientIp, settings.ipAllowlist)) {
    return NextResponse.json({ error: 'forbidden', message: 'ip not allowed' }, { status: 403 });
  }
  // PIN 必須運用のときのみ有効 (issue #244)。`pinRequired=false` では authorize でセッションを発行
  // しない（403）。さもないと verifyPin が任意 PIN で true を返し、誰でも authorize でセッションを
  // 取得して /kiosk ゲート(#239)を回避できる。IP allowlist は単独では認可根拠にしない（client 提供の
  // x-forwarded-for は詐称可能なため／security review）。PIN 不要運用の端末は管理発行 URL/QR で
  // エンロールする。IP allowlist は PIN の上に重ねるアクセス制限として引き続き機能する（上の isIpAllowed）。
  if (!settings.pinRequired) {
    return NextResponse.json(
      { error: 'forbidden', message: 'pin authorization disabled; enroll via issued URL/QR' },
      { status: 403 },
    );
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
