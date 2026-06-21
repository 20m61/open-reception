import { NextResponse } from 'next/server';
import { listIntegrationStatuses } from '@/lib/security/integration-status-store';
import { listAuditLogs } from '@/lib/mock-backend/reception-log-store';
import { toMaskedAuditRows } from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

/** 直近ログとして返す件数の上限（マスク済み）。 */
const RECENT_LIMIT = 20;

/**
 * GET /api/platform/observability — 可観測性の read (issue #90, increment 2)。
 *
 * developer 専用の read-only API。本増分では「取得可能な範囲」を実接続する:
 *   - 外部連携の接続結果（直近成功/失敗・要約。機密値は含めない）。
 *   - 直近の監査ログ（actor をマスクした最小行。PII・機密は含めない）。
 *
 * 未接続（次増分で指標ソースへ接続）:
 *   - エラー率・呼び出し失敗率・Vonage/認証/Lambda・API エラー・レイテンシ・テナント別利用量・
 *     アラート履歴（メトリクス基盤 #89 / 監視連携が必要）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const integrations = await listIntegrationStatuses();
  const logs = await listAuditLogs();
  const recentActivity = toMaskedAuditRows(logs).slice(0, RECENT_LIMIT);
  const pending = { status: 'pending' as const };

  return NextResponse.json({
    integrations,
    recentActivity,
    metrics: {
      errorRate: pending,
      callFailureRate: pending,
      vonageErrors: pending,
      authErrors: pending,
      lambdaApiErrors: pending,
      latency: pending,
      tenantUsage: pending,
      alerts: pending,
    },
  });
}
