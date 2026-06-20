import { NextResponse } from 'next/server';
import { getCheckinService, resolveCheckinScope } from '@/lib/checkin/store';
import { failureResponse, readPayload, requireKioskSession } from '@/lib/checkin/request';
import { createReception } from '@/lib/mock-backend/reception-store';
import { appendAuditLog } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/kiosk/checkin/confirm — 確認後にチェックインし、受付セッションへ接続する (issue #98)。
 *
 * 来訪者が確認画面で「呼び出す」を押した後にのみ呼ばれる（確認必須）。
 *   1. single_use の予約を使用済みにする（markUsed。**確認後のみ使用済み化**）。
 *   2. 既存の受付セッション（#16）を作成して呼び出しフローへ接続する。
 *   3. QR 受付であることを監査ログ（PII なし）に残す。
 *
 * 受付サマリの PII（visitorName / companyName）は受付セッションの visitor へ渡すが、
 * 監査ログには残さない（entryMethod / 予約 target のみ）。
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
  const payload = readPayload(body);
  if (payload === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const { tenantId, siteId } = resolveCheckinScope(session.kioskId);
  let summary;
  try {
    const result = await getCheckinService().confirm(tenantId, siteId, payload);
    if (!result.ok) return failureResponse(result.reason);
    summary = result.summary;
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }

  // 受付セッションを作成して既存の呼び出しフローへ接続する。
  // 予約の呼び出し先表示名は inc1 では targetId をそのまま使う（directory 解決は次増分）。
  const created = await createReception({
    kioskId: session.kioskId,
    purpose: 'meeting',
    targetType: summary.targetType,
    targetId: summary.targetId,
    targetLabel: summary.targetId,
    visitor: { name: summary.visitorName, company: summary.companyName },
  });
  if (!created.ok) {
    return NextResponse.json({ error: 'invalid', message: created.error.message }, { status: 400 });
  }

  // QR 受付であることを監査に残す（PII なし。受付方法と呼び出し先種別のみ）。
  await appendAuditLog({
    action: 'reception.connected',
    actor: `kiosk:${session.kioskId}`,
    targetType: 'reception',
    targetId: created.value.id,
    metadata: { entryMethod: 'qr', targetType: summary.targetType },
  });

  return NextResponse.json({ reception: { id: created.value.id } }, { status: 201 });
}
