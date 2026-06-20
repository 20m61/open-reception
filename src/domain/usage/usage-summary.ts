/**
 * テナント利用量の集計 (issue #89, increment 1)。
 *
 * 管理者は「今月どれくらい受付・通話・通知が使われているか」を業務単位で把握したい。
 * 本モジュールは既存ドメインの受付履歴（ReceptionLog）と監査ログ（AuditLog）から、
 * その利用量を導く純関数群。I/O は持たない（テスト可能な純粋ロジックに閉じる）。
 *
 * データ取得・API 配線は src/lib/mock-backend / src/app/api/admin/usage に置く。
 * 来訪者 PII は集計対象に含めない（ReceptionLog/AuditLog は元々 PII を持たない）。
 *
 * スコープ注記:
 *   - 通話分数は ReceptionLog.durationMs（connected の合計）を業務的な近似として用いる。
 *     実 Vonage 課金分数（接続〜切断の実測）との突合は次増分（docs に根拠を明記）。
 *   - 音声合成回数・API リクエスト数など、現状ログに無い指標は集計対象から外す
 *     （ダッシュボードや design では「準備中」として扱う）。本増分では「ログから確実に
 *     導ける指標」だけを返し、虚の数値を出さない。
 */
import type { AuditLog } from '@/domain/reception/log';
import type { ReceptionLog } from '@/domain/reception/log';

/** 集計の対象期間（半開区間 [start, end)）。境界は呼び出し側が決める。 */
export type UsagePeriod = {
  /** 期間開始（含む）の ISO 文字列。 */
  start: string;
  /** 期間終了（含まない）の ISO 文字列。 */
  end: string;
};

/** 業務単位の利用量サマリ。すべて当該期間内のカウント。 */
export type UsageSummary = {
  period: UsagePeriod;
  /** 受付件数（期間内に開始された受付履歴の総数）。 */
  receptions: number;
  /** 呼び出し成功（connected）件数。 */
  connectedCalls: number;
  /** 未応答（timeout）件数。 */
  timeoutCalls: number;
  /** 失敗（failed）件数。 */
  failedCalls: number;
  /** 代替導線が使われた件数。 */
  fallbackUsed: number;
  /** 接続済み通話の合計分数（durationMs の総和を分に丸めた近似値）。 */
  connectedCallMinutes: number;
  /** 管理画面ログイン回数（監査ログ。現状は記録ソースが無いため通常 0）。 */
  adminLogins: number;
  /** 外部連携の失敗回数（監査ログ。現状は記録ソースが無いため通常 0）。 */
  integrationFailures: number;
};

/** `at`（ISO 文字列）が期間 [start, end) に入るか。不正な日付は false。 */
export function isWithinPeriod(at: string, period: UsagePeriod): boolean {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return false;
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  return t >= start && t < end;
}

/**
 * 基準時刻 `now`（UTC 基準）を含む暦月の期間 [月初, 翌月初) を返す。
 *
 * 「今月」の境界は UTC 月初で固定する。表示上のローカル日付ズレは許容し、集計の
 * 再現性（テスト容易性・テナント横断比較）を優先する。TZ 厳密化は次増分。
 */
export function currentMonthPeriod(now: Date = new Date()): UsagePeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1)).toISOString();
  const end = new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return { start, end };
}

/** `now` の暦月の前月の期間 [前月初, 当月初) を返す（前月比較用）。 */
export function previousMonthPeriod(now: Date = new Date()): UsagePeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  return { start, end };
}

/** ミリ秒を分に丸める（切り上げ。0ms は 0 分）。 */
function msToMinutes(ms: number): number {
  if (ms <= 0) return 0;
  return Math.ceil(ms / 60000);
}

/** 監査ログの action から「管理画面ログイン」とみなすか。現状は該当アクションが無い。 */
function isAdminLogin(_log: AuditLog): boolean {
  // 監査ドメインに admin.login 系アクションが追加されたらここで判定する（#89 次増分）。
  return false;
}

/** 監査ログの action から「外部連携失敗」とみなすか。現状は判定できる記録が無い。 */
function isIntegrationFailure(_log: AuditLog): boolean {
  // integration.tested の失敗は現状 metadata に結果を持たないため数えない（虚の値を出さない）。
  // 将来 metadata.result==='failed' 等が入ったらここで判定する（#89 次増分）。
  return false;
}

/**
 * 受付履歴と監査ログから、指定期間の業務単位利用量を集計する（純関数）。
 *
 * receptions は ReceptionLog.startedAt が期間内のものを対象とする。
 * 監査由来の指標（ログイン・連携失敗）は現状ソースが無いため 0 になるが、UI/コスト側が
 * 「準備中」と「0」を区別できるよう、フィールド自体は常に返す。
 */
export function summarizeUsage(
  receptionLogs: readonly ReceptionLog[],
  auditLogs: readonly AuditLog[],
  period: UsagePeriod,
): UsageSummary {
  const summary: UsageSummary = {
    period,
    receptions: 0,
    connectedCalls: 0,
    timeoutCalls: 0,
    failedCalls: 0,
    fallbackUsed: 0,
    connectedCallMinutes: 0,
    adminLogins: 0,
    integrationFailures: 0,
  };

  let totalConnectedMs = 0;
  for (const log of receptionLogs) {
    if (!isWithinPeriod(log.startedAt, period)) continue;
    summary.receptions += 1;
    if (log.fallbackUsed) summary.fallbackUsed += 1;
    switch (log.outcome) {
      case 'connected':
        summary.connectedCalls += 1;
        totalConnectedMs += Math.max(0, log.durationMs);
        break;
      case 'timeout':
        summary.timeoutCalls += 1;
        break;
      case 'failed':
        summary.failedCalls += 1;
        break;
      case 'cancelled':
        break;
    }
  }
  summary.connectedCallMinutes = msToMinutes(totalConnectedMs);

  for (const log of auditLogs) {
    if (!isWithinPeriod(log.at, period)) continue;
    if (isAdminLogin(log)) summary.adminLogins += 1;
    if (isIntegrationFailure(log)) summary.integrationFailures += 1;
  }

  return summary;
}
