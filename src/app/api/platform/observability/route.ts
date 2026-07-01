import { NextResponse } from 'next/server';
import { listIntegrationStatuses } from '@/lib/security/integration-status-store';
import { listAuditLogs, listReceptionLogsSince } from '@/lib/mock-backend/reception-log-store';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { toMaskedAuditRows } from '@/domain/platform/console-summary';
import { summarizeDevices } from '@/domain/reception/dashboard-summary';
import { currentMonthPeriod, summarizeUsage, deriveUsageRates } from '@/domain/usage/usage-summary';
import { authorizePlatform } from '@/lib/platform/request';

/** 直近ログとして返す件数の上限（マスク済み）。 */
const RECENT_LIMIT = 20;

/**
 * GET /api/platform/observability — 可観測性の read (issue #90, increment 2 / #83 AC 簡易オブザーバビリティ)。
 *
 * developer 専用の read-only API。「取得可能な範囲」を実接続する:
 *   - 外部連携の接続結果（直近成功/失敗・要約。機密値は含めない）。
 *   - 直近の監査ログ（actor をマスクした最小行。PII・機密は含めない）。
 *   - 受付成功率・呼び出し失敗数（当月 JST・受付ログ由来）、端末状態（オンライン/オフライン）。件数のみ・PII なし。
 *
 * 未接続（次増分で指標ソースへ接続）:
 *   - エラー率・認証/Lambda・API エラー・レイテンシ・アラート履歴（メトリクス基盤 / 監視連携が必要）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const now = new Date();
  const period = currentMonthPeriod(now);
  // 当月分のみ必要なため境界クエリで取得（全件走査を避ける, #254）。端末は全テナント横断の状態集計。
  const [integrations, auditLogs, receptionLogs, kiosks] = await Promise.all([
    listIntegrationStatuses(),
    listAuditLogs(),
    listReceptionLogsSince(period.start).catch(() => []),
    listKiosks().catch(() => []),
  ]);

  const recentActivity = toMaskedAuditRows(auditLogs).slice(0, RECENT_LIMIT);
  const usage = summarizeUsage(receptionLogs, [], period);
  const rates = deriveUsageRates(usage);
  const devices = summarizeDevices(
    kiosks.map((k) => ({ id: k.id, displayName: k.displayName, enabled: k.enabled })),
  );
  const pending = { status: 'pending' as const };

  return NextResponse.json({
    integrations,
    recentActivity,
    // 実接続（当月 JST・件数と割合のみ）。
    reception: {
      receptions: usage.receptions,
      successRate: rates.connectedRate, // 受付成功率 = connected / receptions（0 件は null）
      callFailures: usage.failedCalls, // 通話失敗数（Vonage 失敗の近似）
      noAnswer: usage.timeoutCalls, // 未応答
    },
    devices, // { total, online, offline }
    metrics: {
      // メトリクス基盤/監視連携が要る指標は pending 維持。
      errorRate: pending,
      authErrors: pending,
      lambdaApiErrors: pending,
      latency: pending,
      alerts: pending,
    },
  });
}
