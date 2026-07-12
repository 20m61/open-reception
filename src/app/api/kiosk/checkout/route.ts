import { NextResponse } from 'next/server';
import {
  getKioskStayService,
  resolveStayScope,
} from '@/lib/visit/store';
import { appendAuditLog } from '@/lib/data-stores/reception-log-store';
import {
  checkoutFailureResponse,
  readStayId,
  requireKioskSession,
} from '@/lib/visit/request';

/**
 * GET  /api/kiosk/checkout — 当該拠点の在館中（present）一覧を返す (issue #102)。
 * POST /api/kiosk/checkout — 受付番号（stayId）で退館を確定する。
 *
 * いずれも kiosk セッション保護。返すのは PII を含まない滞在情報のみ
 * （id / status / checkedInAt）。退館後の完了画面にも PII を残さない
 * （docs/checkout-stay-design.md §3）。
 */

/**
 * PII を含まない在館サマリ（受付端末の一覧表示用）。
 * 判別材料として呼び出し先ラベル・用件を含む（氏名等 PII は含めない、#328）。
 */
type PresentStaySummary = {
  stayId: string;
  checkedInAt: string;
  targetLabel?: string;
  purpose?: string;
};

export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }
  const { tenantId, siteId } = resolveStayScope(session.kioskId);
  try {
    // 端末からは在館中のみを最小限の非 PII で返す。走査・上限（STAY_LIST_LIMIT）は
    // StayRepository に閉じる（#274 ①: route は collection を直接触らない）。
    const present: PresentStaySummary[] = (
      await getKioskStayService().listPresent(tenantId, siteId)
    ).map((s) => ({
      stayId: s.id,
      checkedInAt: s.checkedInAt,
      targetLabel: s.targetLabel,
      purpose: s.purpose,
    }));
    return NextResponse.json({ stays: present });
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}

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
  const stayId = readStayId(body);
  if (stayId === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const { tenantId, siteId } = resolveStayScope(session.kioskId);
  try {
    const result = await getKioskStayService().checkOutById(tenantId, siteId, stayId);
    if (!result.ok) return checkoutFailureResponse(result.reason);
    // 退館を監査に残す（PII なし。滞在 id と状態のみ）。
    await appendAuditLog({
      action: 'visitor.checked_out',
      actor: `kiosk:${session.kioskId}`,
      targetType: 'stay',
      targetId: result.receipt.stayId,
      metadata: { entryMethod: 'kiosk' },
    });
    return NextResponse.json({ receipt: result.receipt }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}
