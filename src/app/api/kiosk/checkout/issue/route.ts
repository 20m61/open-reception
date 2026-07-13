import { NextResponse } from 'next/server';
import { asStayId } from '@/domain/visit/types';
import { getCheckoutCredentialService } from '@/lib/visit/checkout-credential';
import { getStayRepository, resolveStayScope } from '@/lib/visit/store';
import { readStayId, requireKioskSession } from '@/lib/visit/request';

/**
 * POST /api/kiosk/checkout/issue — 在館中の滞在に退館クレデンシャルを発行する (issue #328)。
 *
 * 受付完了画面 / 予約 QR が来訪者へ提示する**退館 QR token + 短コード**を払い出す。
 * kiosk セッション保護。入力は在館中（present）の stayId のみ（PII は受け取らない）。
 * 発行値（token/code/expiresAt）は提示のために返すが、監査・ログには残さない。
 *
 * 注: 受付完了画面 / 予約 QR への**表示配線**は他トラック所有 UI（KioskFlow / reservation）に
 * 依存するため次増分（docs/checkout-stay-design.md §8.6）。本エンドポイントは発行 API を先行提供する。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const rawStayId = readStayId(body);
  if (rawStayId === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const scope = await resolveStayScope(session.kioskId);
  try {
    const stay = await getStayRepository().get(scope.tenantId, scope.siteId, asStayId(rawStayId));
    // 在館中のみ発行対象（退館済み/取消/越境は not_found で秘匿）。
    if (!stay || stay.status !== 'present') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const issued = getCheckoutCredentialService().issue({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      stayId: stay.id,
      checkedInAt: stay.checkedInAt,
      targetLabel: stay.targetLabel ?? '',
      purpose: stay.purpose ?? '',
    });
    return NextResponse.json(
      { token: issued.token, code: issued.code, expiresAt: issued.expiresAt },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}
