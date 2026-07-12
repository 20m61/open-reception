/**
 * テナント管理者向けダッシュボードの概況集計 (issue #86, increment 1)。
 *
 * 受付システムの管理者が最初に知りたいのは細かい設定値ではなく
 * 「いま受付が安全に動いているか」である。本モジュールは受付履歴（ReceptionLog）と
 * 端末死活サマリ（#261: kiosk/Device union の実 heartbeat 集計）から概況を導く純関数群。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。データ取得と API 配線は
 * src/lib/data-stores / src/lib/tenant/device-fleet.ts / src/app/api/admin/dashboard に置く。
 * 実データが無い指標（Vonage 連携状態・お知らせ）は #89 / #82 / #90 の本実装まで
 * プレースホルダ扱いとし、ここでは集計しない。
 */
import type { FleetSummary } from '@/domain/tenant/device-liveness';
import type { CallOutcome } from './session';
import type { ReceptionLog } from './log';
import { jstDayKey } from '@/domain/util/jst';
import { summarizeExperience, type ExperienceKpi } from './experience-summary';

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

/**
 * 端末稼働の集計 (#261 で実死活の共有型 FleetSummary へ統一)。
 * platform オブザーバビリティと同一ロジック（summarizeDeviceFleet）から供給される。
 * total は稼働可能端末のみ（= online + offline）。maintenance/disabled は別掲。
 */
export type DeviceSummary = FleetSummary;

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
/**
 * 利用量・予想コストの概況（#86/#89）。ダッシュボードに概要だけを出し、詳細は各画面へ誘導する。
 * 集約 API が usage/cost 集計から組み立てて渡す（フロントで複数 API を叩かない）。
 */
export type UsageCostSummary = {
  /** 当月の受付件数。 */
  receptionsThisMonth: number;
  /** 今月これまでの概算コスト（円）。 */
  estimatedSoFar: number;
  /** 月末までの予想コスト概算（円）。 */
  projectedMonthEnd: number;
  currency: 'JPY';
};

export type DashboardSummary = {
  status: OverallStatus;
  today: TodayCounts;
  devices: DeviceSummary;
  recentCalls: RecentCall[];
  /** 利用量・予想コストの概況（未集計時は null）。 */
  usageCost: UsageCostSummary | null;
  /**
   * 本日（JST）の受付体験 KPI (issue #319)。30 秒以内呼び出し開始率・完遂率・中央値所要・
   * ステップ別ファネル。体験メトリクスを持つログのみ 30 秒 KPI/ファネルの対象になる。
   * 期間指定表示は同じ summarizeExperience を期間フィルタ済みログに適用して実現する（次増分で UI）。
   */
  experience: ExperienceKpi;
};

// 「本日」は **JST** で判定する (issue #254)。ランタイムの TZ に依存させない（Lambda/OpenNext は
// UTC のため、サーバローカル暦日だと JST 早朝/深夜の受付が別日に計上されてしまう）。日付境界の
// ロジックは domain/util/jst に集約（usage/cost の「今月/トレンド」と JST 境界を揃えるため）。

/** 受付履歴から本日（JST）分のみを抽出する。無効な now は本日なし（graceful empty）。 */
function filterToday(logs: readonly ReceptionLog[], now: Date): ReceptionLog[] {
  const nowKey = jstDayKey(now.getTime());
  if (nowKey === null) return [];
  return logs.filter((log) => jstDayKey(new Date(log.startedAt).getTime()) === nowKey);
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
 * - critical: 稼働可能端末（total = online+offline）が 1 台以上あるのに全台オフライン。
 *             全台が保守/無効（total=0）は意図的な停止のため critical にしない (#261)。
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

/**
 * 受付履歴と端末死活サマリから概況サマリ全体を組み立てる。
 * devices は summarizeDeviceFleet（kiosk/Device union・実 heartbeat, #261）の結果を渡す。
 */
export function buildDashboardSummary(
  logs: readonly ReceptionLog[],
  devices: DeviceSummary,
  now: Date = new Date(),
  usageCost: UsageCostSummary | null = null,
): DashboardSummary {
  const today = summarizeToday(logs, now);
  return {
    status: deriveOverallStatus(today, devices),
    today,
    devices,
    recentCalls: recentCalls(logs),
    usageCost,
    // 体験 KPI は「本日（JST）」に絞ったログで集計する（件数集計と同じ境界, #254/#319）。
    experience: summarizeExperience(filterToday(logs, now)),
  };
}
