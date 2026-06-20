/**
 * テナント管理者向けダッシュボードの概況集計 (issue #86, increment 1)。
 *
 * 受付システムの管理者が最初に知りたいのは細かい設定値ではなく
 * 「いま受付が安全に動いているか」である。本モジュールは既存ドメインの
 * 受付履歴（ReceptionLog）と端末レジストリ（Kiosk）から、その概況を導く純関数群。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。データ取得と API 配線は
 * src/lib/mock-backend / src/app/api/admin/dashboard に置く。実データが無い指標
 * （Vonage 連携状態・利用量・予想コスト・お知らせ）は #89 / #82 / #90 の本実装まで
 * プレースホルダ扱いとし、ここでは集計しない。
 */
import type { CallOutcome } from './session';
import type { ReceptionLog } from './log';

/** 端末稼働の集計に必要な最小限の端末情報（Kiosk の部分形）。 */
export type DeviceLike = {
  id: string;
  displayName: string;
  enabled: boolean;
};

/** 概況の総合ステータス。正常 / 注意 / 異常を視覚的に区別する起点。 */
export type OverallStatus = 'ok' | 'warning' | 'critical';

/** 本日の受付集計。 */
export type TodayCounts = {
  /** 本日の受付件数（履歴の startedAt がその日に入るもの）。 */
  total: number;
  /** 呼び出し成功（connected）。 */
  connected: number;
  /** 未応答（timeout）。 */
  timeout: number;
  /** 失敗（failed）。 */
  failed: number;
  /** キャンセル（cancelled）。 */
  cancelled: number;
  /** 失敗 + 未応答後に代替導線が使われた件数。 */
  fallbackUsed: number;
};

/** 端末稼働の集計。 */
export type DeviceSummary = {
  total: number;
  online: number;
  offline: number;
};

/** 直近の呼び出し履歴（表示用に PII を含まない最小形）。 */
export type RecentCall = {
  id: string;
  kioskId: string;
  targetLabel?: string;
  outcome: CallOutcome;
  fallbackUsed: boolean;
  startedAt: string;
  durationMs: number;
};

/** ダッシュボード概況の集計結果。 */
export type DashboardSummary = {
  status: OverallStatus;
  today: TodayCounts;
  devices: DeviceSummary;
  recentCalls: RecentCall[];
};

/** `at`（ISO 文字列）が、基準時刻 `now` と同じ暦日（ローカル）かを判定する。 */
function isSameLocalDay(at: string, now: Date): boolean {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** 受付履歴から本日分のみを抽出する。 */
function filterToday(logs: readonly ReceptionLog[], now: Date): ReceptionLog[] {
  return logs.filter((log) => isSameLocalDay(log.startedAt, now));
}

/** 本日の受付件数・呼び出し成否を集計する。 */
export function summarizeToday(logs: readonly ReceptionLog[], now: Date = new Date()): TodayCounts {
  const todays = filterToday(logs, now);
  const counts: TodayCounts = {
    total: todays.length,
    connected: 0,
    timeout: 0,
    failed: 0,
    cancelled: 0,
    fallbackUsed: 0,
  };
  for (const log of todays) {
    counts[log.outcome] += 1;
    if (log.fallbackUsed) counts.fallbackUsed += 1;
  }
  return counts;
}

/** 端末レジストリから稼働状況を集計する（enabled = オンライン稼働とみなす）。 */
export function summarizeDevices(devices: readonly DeviceLike[]): DeviceSummary {
  const online = devices.filter((d) => d.enabled).length;
  return { total: devices.length, online, offline: devices.length - online };
}

/** 直近の呼び出し履歴を新しい順で最大 `limit` 件返す（PII は含めない）。 */
export function recentCalls(logs: readonly ReceptionLog[], limit = 5): RecentCall[] {
  return [...logs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit)
    .map((log) => ({
      id: log.id,
      kioskId: log.kioskId,
      targetLabel: log.targetLabel,
      outcome: log.outcome,
      fallbackUsed: log.fallbackUsed,
      startedAt: log.startedAt,
      durationMs: log.durationMs,
    }));
}

/**
 * 本日の集計と端末稼働から総合ステータスを導く（純関数）。
 *
 * - critical: 全端末オフライン（端末が 1 台以上登録されているのに稼働ゼロ）。
 * - warning:  本日の呼び出し失敗/未応答がある、または一部端末がオフライン。
 * - ok:       上記いずれにも該当しない。
 *
 * しきい値は運用知見が貯まる前の素朴な定義。閾値調整・Vonage/コスト連動は次増分。
 */
export function deriveOverallStatus(today: TodayCounts, devices: DeviceSummary): OverallStatus {
  if (devices.total > 0 && devices.online === 0) return 'critical';
  const hasCallProblem = today.failed > 0 || today.timeout > 0;
  const hasOfflineDevice = devices.offline > 0;
  if (hasCallProblem || hasOfflineDevice) return 'warning';
  return 'ok';
}

/** 受付履歴と端末から概況サマリ全体を組み立てる。 */
export function buildDashboardSummary(
  logs: readonly ReceptionLog[],
  devices: readonly DeviceLike[],
  now: Date = new Date(),
): DashboardSummary {
  const today = summarizeToday(logs, now);
  const deviceSummary = summarizeDevices(devices);
  return {
    status: deriveOverallStatus(today, deviceSummary),
    today,
    devices: deviceSummary,
    recentCalls: recentCalls(logs),
  };
}
