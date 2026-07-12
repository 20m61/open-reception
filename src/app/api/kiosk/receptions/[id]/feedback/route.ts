import { NextResponse } from 'next/server';
import { recordSatisfactionFeedback } from '@/lib/data-stores/reception-log-store';
import { requireKioskSession } from '@/lib/kiosk/session-guard';

const ERROR_STATUS = {
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
} as const;

/**
 * POST /api/kiosk/receptions/:id/feedback — ワンタップ満足度フィードバック (issue #320)。
 *
 * 完了/未応答/失敗の終端画面から、来訪者が任意で送る評価（3 段階）と定型理由コードを記録する。
 * **自由記述フィールドは無い**（ボディに自由文を含めても構造的に保存できない、`sanitizeReceptionFeedback`
 * 参照）。kiosk セッション必須（他 API と同じ #239 の方針）。対象 reception を作成した端末以外
 * からの要求はストア層の所有権チェックで 403 になる。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'invalid JSON' }, { status: 400 });
  }
  const { id } = await params;
  const result = await recordSatisfactionFeedback(id, session.kioskId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] });
  }
  return NextResponse.json({ ok: true });
}
