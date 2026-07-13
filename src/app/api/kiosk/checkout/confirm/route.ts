import { NextResponse } from 'next/server';
import { appendAuditLog } from '@/lib/data-stores/reception-log-store';
import { getCheckoutCredentialService } from '@/lib/visit/checkout-credential';
import { getKioskStayService, resolveStayScope } from '@/lib/visit/store';
import {
  checkoutFailureResponse,
  checkoutSelfIdFailureResponse,
  readCheckoutResolveInput,
  requireKioskSession,
} from '@/lib/visit/request';

/**
 * POST /api/kiosk/checkout/confirm — 確認後に自己特定退館を確定する (issue #328)。
 *
 * 来訪者が確認画面（入館時刻 + 呼び出し先ラベル + 用件、氏名なし）で「はい」を押した後にのみ呼ぶ。
 *   1. クレデンシャルを**状態変更せず**解決する（code 経路はスロットル + オラクル封じを適用）。
 *   2. 滞在を present → checked_out に確定する（純関数 checkOut 経由）。
 *   3. **checkout 成功後にのみ** クレデンシャルを consumed 化する（markConsumed）。
 *      失敗時はクレデンシャルを焼失させず、来訪者が再試行できるようにする（締め出し防止）。
 *   4. 自己特定退館であることを監査に残す（PII なし。method='qr'|'code' のみ）。
 *
 * token/code/PII はレスポンスにも監査にも残さない（`rules/pii-secret-minimization.md`）。
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

  const scope = await resolveStayScope(session.kioskId);
  const credentials = getCheckoutCredentialService();
  // 状態は変更しない（consumed 化は checkout 成功後）。
  const resolved = credentials.resolveForCheckout(scope, input);
  if (!resolved.ok) return checkoutSelfIdFailureResponse(resolved.reason);

  try {
    const result = await getKioskStayService().checkOutById(
      scope.tenantId,
      scope.siteId,
      resolved.stayId,
    );
    // checkout 失敗時はクレデンシャルを consumed にせず、来訪者が再試行できるようにする。
    if (!result.ok) return checkoutFailureResponse(result.reason);

    // checkout 成功後にのみクレデンシャルを無効化する（再利用防止）。
    credentials.markConsumed(resolved.credentialToken);

    // 自己特定退館の監査（PII なし。手段種別と滞在 id のみ）。
    await appendAuditLog({
      action: 'visitor.checkout_self_identified',
      actor: `kiosk:${session.kioskId}`,
      targetType: 'stay',
      targetId: result.receipt.stayId,
      metadata: { method: resolved.method },
    });

    return NextResponse.json({ receipt: result.receipt }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}
