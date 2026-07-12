import { NextResponse } from 'next/server';
import { getReception } from '@/lib/data-stores/reception-store';
import {
  receptionToCreateStayInput,
  shouldCreateStayForReception,
} from '@/domain/visit/reception-stay';
import { getKioskStayService, resolveStayScope } from '@/lib/visit/store';
import { requireKioskSession } from '@/lib/visit/request';

/**
 * POST /api/kiosk/stay — 受付完了時に在館記録（VisitStay）を自動生成する (issue #342)。
 *
 * 受付完了画面が、担当者応答で完了した受付（connected → completed）について呼ぶ。
 * kiosk セッション保護。入力は `{ receptionId }` のみ（PII は受け取らない）。
 *
 * scope（tenant/site）は **resolveStayScope(session.kioskId) 由来のみ**で解決する
 * （既存の checkout issue/resolve/confirm と同一。クライアント入力で scope を決めない = 越境しない）。
 * receptionId は受付の非 PII メタデータ（targetLabel/purpose）読み取りと参照にのみ使い、scope には
 * 影響させない。よって後続の /api/kiosk/checkout/issue（同じ scope 解決）は同 scope で在館記録を見つける。
 *
 * 返すのは `{ stayId }` のみ（退館クレデンシャル発行の入力に使う）。氏名等 PII は返さない。
 * 冪等: 同一 receptionId は在館記録を二重生成せず既存 id を返す（サービス層で担保）。
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
  const receptionId = readReceptionId(body);
  if (receptionId === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  try {
    const found = await getReception(receptionId);
    // 受付が見つからない場合は not_found（存在しない受付から在館を作らない）。
    if (!found.ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // 対象 reception を作成した端末（reception.kioskId）からの要求に限定する
    // （token/status 兄弟ルートと同じ受付所有権チェック。他端末の受付を在館化させない）。
    if (found.value.kioskId !== session.kioskId) {
      return NextResponse.json({ error: 'forbidden', message: 'reception belongs to another kiosk' }, { status: 403 });
    }
    // 担当者応答で完了した受付のみ在館化する（未応答/失敗/取消/フォールバック完了は対象外）。
    if (!shouldCreateStayForReception(found.value)) {
      return NextResponse.json({ error: 'not_eligible' }, { status: 409 });
    }

    const scope = resolveStayScope(session.kioskId);
    const stayId = await getKioskStayService().createPresentForReception({
      scope,
      stay: receptionToCreateStayInput(found.value, scope),
      kioskId: session.kioskId,
    });
    return NextResponse.json({ stayId }, { status: 201 });
  } catch (e) {
    // 在館記録の生成失敗は受付フローを止めない（503）。原因追跡のため非ブロッキングに記録する
    // （PII/token は載せない。error オブジェクトのみ）。
    console.warn('[kiosk-stay] create failed', e);
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}

/** リクエストボディから受付セッション id を取り出す。空・非文字列は null。 */
function readReceptionId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as Record<string, unknown>).receptionId;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
