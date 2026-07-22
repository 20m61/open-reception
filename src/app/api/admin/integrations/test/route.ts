import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { runConnectionTest } from '@/lib/security/connection-test';
import {
  isKnownIntegration,
  recordConnectionResult,
} from '@/lib/security/integration-status-store';
import { getVonagePresenceForTenant } from '@/lib/platform/integration-presence';
import { actorLabel, authorize } from '../authz';

/**
 * POST /api/admin/integrations/test — 外部連携の接続テストを実行する (issue #93)。
 *
 * body: { tenantId: string, id: string }
 *
 * inc1 はネットワーク発信を行わない「設定検証」のみ（本番発信とは区別）。
 * 実発信・テスト発信は実認証情報/実機が要るため次増分（#65）。
 *
 * presence の供給源はテナント設定（`getVonagePresenceForTenant`・既定テナント）へ移行済み。旧
 * グローバル `VONAGE_*` env は読まない（#405 Inc3）。
 *
 * 認証: 管理セッション必須。認可: canAccessTenant(write) — tenant_admin 以上のみ実行可。
 * 監査: integration.tested を記録（結果のみ。機密は残さない）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const result = await authorize(body ?? {}, 'write');
  if (!result.ok) return result.response;

  const id = typeof body?.id === 'string' ? body.id : '';
  if (!isKnownIntegration(id)) {
    return NextResponse.json({ error: 'invalid_input', message: 'unknown integration' }, { status: 400 });
  }

  // presence は**認可済み tenantId**（authorize が canAccessTenant で検証した対象）で判定する。
  // 既定テナント固定にすると tenant_admin が自テナント以外の設定状態を観測しうるため一致させる。
  const presence = await getVonagePresenceForTenant(String(result.auth.tenantId));
  const outcome = runConnectionTest(id, presence);
  const lastResult = await recordConnectionResult(id, outcome.result, outcome.summary);

  await appendAdminAudit('integration.tested', { type: 'integration', id }, {
    result: outcome.result,
    actor: actorLabel(result.auth.actor),
  });

  return NextResponse.json({ id, result: lastResult, summary: outcome.summary });
}
