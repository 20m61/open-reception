import { NextResponse } from 'next/server';
import { getSecuritySettings, verifyPin } from '@/lib/security/security-store';
import { isIpAllowed } from '@/domain/security/types';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import { readJson } from '@/lib/mock-backend/result-http';

/**
 * POST /api/kiosk/authorize — PIN / IP による受付端末の初回許可 (issue #23)。
 * 許可後は長期 kiosk session cookie を発行し、リロード/再起動後も受付画面に復帰できる。
 *
 * 認可の基盤は **PIN 必須 または IP allowlist** (issue #23 / #244)。どちらの制限も無い完全開放状態
 * （`pinRequired=false` かつ `ipAllowlist` 空）では公開セッションを発行せず 403 を返す。さもないと
 * `verifyPin` が任意 PIN で true を返し、誰でも authorize でセッションを取得して `/kiosk` ゲート (#239) を
 * 回避できる。IP allowlist 運用（IP-only）は保持し、PIN 不要・IP 制限も無い端末は管理発行 URL/QR で
 * エンロールする。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { pin?: unknown; kioskId?: unknown } | null;
  const settings = await getSecuritySettings();
  const clientIp = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';

  if (!isIpAllowed(clientIp, settings.ipAllowlist)) {
    return NextResponse.json({ error: 'forbidden', message: 'ip not allowed' }, { status: 403 });
  }
  // PIN も IP 制限も無い（完全開放）状態では公開セッションを発行しない (issue #244)。さもないと
  // verifyPin が任意 PIN で true を返し、誰でも authorize でセッションを取得して /kiosk ゲート(#239)を
  // 回避できる。IP allowlist が設定済みなら上の isIpAllowed で許可 IP に制限済みのため、IP 認可
  // （#23 の IP-only 運用）として成立させる。いずれの制限も無い端末は管理発行 URL/QR でエンロールする。
  if (!settings.pinRequired && settings.ipAllowlist.length === 0) {
    return NextResponse.json(
      { error: 'forbidden', message: 'no pin or ip restriction configured; enroll via issued URL/QR' },
      { status: 403 },
    );
  }
  // PIN 必須運用のみ PIN を検証する（IP-only 運用では IP 認可で足りる）。
  if (settings.pinRequired) {
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    if (!(await verifyPin(pin))) {
      return NextResponse.json({ error: 'unauthorized', message: 'invalid pin' }, { status: 401 });
    }
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
