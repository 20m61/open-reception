import { NextResponse } from 'next/server';
import { resolveCheckinScope } from '@/lib/checkin/store';
import { requireKioskSession } from '@/lib/checkin/request';
import { getReceptionFlowService } from '@/lib/reception/flow-config/store';

/**
 * GET /api/kiosk/flow — 受付端末セッションのサイトで有効な受付フロー一覧を返す (issue #100)。
 *
 * 認証: 有効な kiosk セッション必須（無効なら 403）。管理 API ではなく端末からの要求。
 * scope（tenant/site）は kiosk セッションから解決する（resolveCheckinScope を再利用）。
 * 返すのは「有効な」フローのみを表示順に整列したもの。バックエンド障害時は 503 を返し、
 * 受付端末は通常受付フォールバックに倒せる。来訪者の PII は一切含まない（テンプレート）。
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }

  const { tenantId, siteId } = resolveCheckinScope(session.kioskId);
  try {
    const flows = await getReceptionFlowService().listEnabledForKiosk(tenantId, siteId);
    return NextResponse.json({ flows });
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}
