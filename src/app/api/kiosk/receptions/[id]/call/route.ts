import { NextResponse } from 'next/server';
import { startCall } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { executeRoutedCall, routedCallAdapter } from '@/lib/routing/call-execution';

/**
 * POST /api/kiosk/receptions/:id/call — 呼び出しを開始する (issue #16, #20, #374)。
 *
 * テナント/サイトに**保存済みのルーティングポリシー**があれば、そのルート定義（順次取次・
 * 結果別遷移・fallback）を Orchestrator で段階実行し（外部発信は mock provider のまま）、
 * 応答へ取次段階 `stages[]` を後方互換で付す（#363 injection point 4）。
 *
 * ルート未設定テナントは `executeRoutedCall` が null を返し、従来どおり単発 Mock adapter の
 * 結果で connected / timeout / failed へ確定する（fail-open。既存 e2e/挙動を維持）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;

  // 保存済みルートに従った段階実行を試みる。読み取り/実行で失敗しても取次自体は止めない
  // （fail-open で従来の単発 Mock へ）。fail-open は無音にせずログで可観測にする（PII なし）。
  const routed = await executeRoutedCall(resolveDefaultScope(), id).catch((err: unknown) => {
    console.error('[kiosk/call] routed execution failed; falling back to single mock call', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  });
  const result = await startCall(id, routed ? routedCallAdapter(routed) : undefined);

  // エラー時、またはルート未設定（fail-open）時は従来どおりの応答（stages なし）。
  if (!result.ok || routed === null) return toResponse(result);

  // 後方互換: 既存フィールド（ReceptionSession）を維持しつつ、実行段階を stages[] で供給する。
  return NextResponse.json({ ...result.value, stages: routed.stages });
}
