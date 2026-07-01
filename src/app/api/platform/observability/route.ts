import { NextResponse } from 'next/server';
import { listIntegrationStatuses } from '@/lib/security/integration-status-store';
import { listAuditLogs, listReceptionLogsSince } from '@/lib/mock-backend/reception-log-store';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { toMaskedAuditRows } from '@/domain/platform/console-summary';
import { summarizeDevices } from '@/domain/reception/dashboard-summary';
import { currentMonthPeriod, summarizeUsage } from '@/domain/usage/usage-summary';
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
  // 監視画面なので取得失敗は握り潰さず伝播させる（偽の健全表示を出さない。UI は !res.ok で明示）。
  const [integrations, auditLogs, receptionLogs, kiosks] = await Promise.all([
    listIntegrationStatuses(),
    listAuditLogs(),
    listReceptionLogsSince(period.start),
    listKiosks(),
  ]);

  const recentActivity = toMaskedAuditRows(auditLogs).slice(0, RECENT_LIMIT);
  const usage = summarizeUsage(receptionLogs, [], period);
  // 受付成功率は「通話を試みた受付」を分母にする（cancelled=来訪者が離脱で通話未試行、は除外）。
  const callAttempts = usage.connectedCalls + usage.timeoutCalls + usage.failedCalls;
  const successRate = callAttempts > 0 ? usage.connectedCalls / callAttempts : null;
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
      successRate, // connected / (connected+timeout+failed)。試行 0 は null
      callFailures: usage.failedCalls, // 通話失敗数（Vonage 失敗の近似）
      noAnswer: usage.timeoutCalls, // 未応答
    },
    // 注: devices.online は「有効フラグ」ベース（実死活=heartbeat は次増分）。UI も「有効な端末」と表記。
    devices, // { total, online, offline }（online=enabled 数）
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
