import { NextResponse } from 'next/server';
import { startCall } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { voiceDialingDisabled } from '@/lib/routing/voice-dial';
import { executeRoutedCall, routedCallAdapter } from '@/lib/routing/call-execution';
import { resolveWebhookBaseUrl } from '@/lib/routing/webhook-base-url';
import { evaluateCallGuard } from '@/lib/operating-policy/call-guard';

/**
 * POST /api/kiosk/receptions/:id/call — 呼び出しを開始する (issue #16, #20, #374, #367)。
 *
 * テナント/サイトに**保存済みのルーティングポリシー**があれば、そのルート定義（順次取次・
 * 結果別遷移・fallback）に従って取次を実行し、応答へ取次段階 `stages[]` を後方互換で付す
 * （#363 injection point 4）。
 *
 * 実行経路は 2 つ (#4 Inc D-2 項目 2)。テナント設定が vonage + 資格情報完備なら**実 PSTN 発信**
 * （1 手撃って `calling` を返し、応答/未応答は provider webhook で確定する）。それ以外は
 * 従来どおり mock provider の同期段階実行。**既定は mock**（資格情報が欠ければ倒れる）。
 *
 * ルート未設定テナントは `executeRoutedCall` が null を返し、従来どおり単発 Mock adapter の
 * 結果で connected / timeout / failed へ確定する（fail-open。既存 e2e/挙動を維持）。
 *
 * 営業時間外ガード (#367): 保存済み `ServiceOperatingPolicy` が closed と判定した場合、新規発信を
 * 409（`out_of_hours`）で拒否する（#4 AC「営業時間外は新規発信を拒否する」）。ポリシー未設定・
 * 判定不能は fail-open（従来どおり許可）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  const scope = resolveDefaultScope();

  const guard = await evaluateCallGuard(scope.tenantId, scope.siteId);
  if (!guard.allowed) {
    return NextResponse.json(
      { error: 'out_of_hours', reason: guard.reason, ...(guard.reopenAt ? { reopenAt: guard.reopenAt } : {}) },
      { status: 409 },
    );
  }

  // 🔴 **実発信を止めているなら、呼び出したふりをしない (N0)。**
  // 以前はここを素通りして `executeRoutedCall` → mock へ倒れ、mock が bridge 系を
  // 無条件で `'answered'` にするため、来訪者には「担当者が応答しました」と出て
  // `completed` に到達していた —— **誰も呼ばれていないのに全員が受付完了する**。
  // 運用者からは「全員入館できている」ように見えるので、全断に気づくのが遅れる。
  //
  // 「止めても来訪者を締め出さない」という設計意図（`voice-dial.ts`）は保つ:
  // 受付は `failed` で終端し、逃げ道バーと有人支援の案内が出る。**やめるのは嘘だけ。**
  if (voiceDialingDisabled()) {
    return NextResponse.json({ error: 'unrouted' }, { status: 503 });
  }

  // 保存済みルートに従った段階実行を試みる。読み取り/実行で失敗しても取次自体は止めない
  // （fail-open で従来の単発 Mock へ）。fail-open は無音にせずログで可観測にする（PII なし）。
  // 🔴 `webhookBaseUrl` を渡さないと実発信は**永久に起こらない**（`executeRoutedCall` は
  // 分からなければ mock へ倒す）。CloudFront のドメインで解決すること — Function URL だと
  // Vonage の webhook が origin-verify に落ちて 403 になる（#612 と同型）。
  const routed = await executeRoutedCall(scope, id, {
    webhookBaseUrl: resolveWebhookBaseUrl(request),
  }).catch((err: unknown) => {
    console.error('[kiosk/call] routed execution failed; falling back to single mock call', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  });
  // ルート未設定（fail-open）時の単発 adapter は、営業時間ガード/routing と同じ scope の
  // tenantId で解決する（テナント設定が vonage+secret 完備なら本番 adapter。既定は Mock）。
  const result = await startCall(id, routed ? routedCallAdapter(routed) : undefined, scope.tenantId);

  // エラー時、またはルート未設定（fail-open）時は従来どおりの応答（stages なし）。
  if (!result.ok || routed === null) return toResponse(result);

  // 後方互換: 既存フィールド（ReceptionSession）を維持しつつ、実行段階を stages[] で供給する。
  return NextResponse.json({ ...result.value, stages: routed.stages });
}
