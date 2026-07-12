import { NextResponse } from 'next/server';
import { getCheckoutCredentialService } from '@/lib/visit/checkout-credential';
import { resolveStayScope } from '@/lib/visit/store';
import {
  checkoutSelfIdFailureResponse,
  readCheckoutResolveInput,
  requireKioskSession,
} from '@/lib/visit/request';

/**
 * POST /api/kiosk/checkout/resolve — 退館の自己特定手段を解決する (issue #328)。
 *
 * QR token（`{ payload }`）か 短コード + 呼び出し先ラベル（`{ code, targetLabel }`）から、
 * 確認画面用の**非 PII サマリ**（入館時刻 + 呼び出し先ラベル + 用件）を返す。
 * **使用済み化はしない**（確認画面で来訪者の操作を待つ。確定は /confirm）。
 * コード経路は失敗時に試行を消費し、上限で locked を返す（総当り耐性、docs §8）。
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
  const input = readCheckoutResolveInput(body);
  if (input === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const scope = resolveStayScope(session.kioskId);
  const result = getCheckoutCredentialService().resolve(scope, input);
  if (!result.ok) return checkoutSelfIdFailureResponse(result.reason);
  return NextResponse.json({ method: result.method, summary: result.summary });
}
