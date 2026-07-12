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
import { summarizeSatisfaction, type SatisfactionSummary } from './satisfaction-summary';

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

/** ダッシュボードの体験 KPI 期間プリセットのキー (issue #319)。 */
export type ExperiencePeriodKey = 'today' | 'last7d' | 'last30d';

/** 期間プリセットごとの体験 KPI（ダッシュボードの期間指定表示用）。 */
export type ExperiencePeriodKpi = {
  key: ExperiencePeriodKey;
  /** 管理画面表示ラベル（日本語・i18n 対象外）。 */
  label: string;
  /** 対象の JST 暦日数（本日を含む直近 N 日。today=1）。 */
  days: number;
  /** その期間に絞ったログの体験 KPI。 */
  kpi: ExperienceKpi;
};

/** 期間プリセットごとの満足度フィードバック集計（issue #320・体験 KPI と同じ期間プリセットを共有）。 */
export type SatisfactionPeriodKpi = {
  key: ExperiencePeriodKey;
  /** 管理画面表示ラベル（日本語・i18n 対象外）。 */
  label: string;
  /** 対象の JST 暦日数（本日を含む直近 N 日。today=1）。 */
  days: number;
  /** その期間に絞ったログの満足度集計。 */
  summary: SatisfactionSummary;
};

/**
 * 期間プリセット定義 (issue #319 AC「期間指定で見られる」)。JST 暦日で「本日を含む直近 N 日」を切る。
 * 定義はここ 1 箇所に集約し、ラベル/日数を集計と表示で共有する。体験 KPI (#319) と満足度
 * フィードバック (#320) の期間指定は同一のプリセット（本日/直近7日/直近30日）を共有する。
 */
const EXPERIENCE_PERIOD_DEFS: readonly { key: ExperiencePeriodKey; label: string; days: number }[] = [
  { key: 'today', label: '本日', days: 1 },
  { key: 'last7d', label: '直近7日', days: 7 },
  { key: 'last30d', label: '直近30日', days: 30 },
];

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
   * 期間指定表示は `experiencePeriods` で提供する（本フィールドは本日プリセットと同値・後方互換）。
   */
  experience: ExperienceKpi;
  /**
   * 期間指定の体験 KPI プリセット (issue #319 AC)。本日/直近7日/直近30日を JST 暦日境界で集計する。
   * クライアントは追加 API を叩かず、これらの中から表示期間を切り替える（集約 API 1 本の方針を維持）。
   */
  experiencePeriods: ExperiencePeriodKpi[];
  /**
   * 本日（JST）のワンタップ満足度フィードバック集計 (issue #320)。評価分布・終端状態別内訳。
   * 期間指定表示は `satisfactionPeriods` で提供する（本フィールドは本日プリセットと同値・後方互換）。
   */
  satisfaction: SatisfactionSummary;
  /**
   * 期間指定の満足度フィードバック集計プリセット (issue #320 AC「期間指定の評価集計」)。
   * 本日/直近7日/直近30日を JST 暦日境界で集計する（体験 KPI と同じプリセット定義を共有）。
   */
  satisfactionPeriods: SatisfactionPeriodKpi[];
};

// 「本日」は **JST** で判定する (issue #254)。ランタイムの TZ に依存させない（Lambda/OpenNext は
// UTC のため、サーバローカル暦日だと JST 早朝/深夜の受付が別日に計上されてしまう）。日付境界の
// ロジックは domain/util/jst に集約（usage/cost の「今月/トレンド」と JST 境界を揃えるため）。

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 受付履歴から「本日を含む直近 `days` JST 暦日」に入るものだけを抽出する (issue #319)。
 *
 * JST 暦日境界で判定する（#254 の `jstDayKey` と揃える）。`days` 日分を含む最古の暦日は
 * `now - (days-1)日` の JST 暦日。JST は固定オフセット（DST なし）のため 24h 倍数の減算で
 * 時刻を保ったまま暦日だけがずれ、境界が正確。無効な now / startedAt は除外（graceful empty）。
 */
export function filterWithinJstDays(
  logs: readonly ReceptionLog[],
  now: Date,
  days: number,
): ReceptionLog[] {
  const nowKey = jstDayKey(now.getTime());
  if (nowKey === null) return [];
  const minKey = jstDayKey(now.getTime() - Math.max(0, days - 1) * DAY_MS);
  if (minKey === null) return [];
  return logs.filter((log) => {
    const key = jstDayKey(new Date(log.startedAt).getTime());
    return key !== null && key >= minKey && key <= nowKey;
  });
}

/** 受付履歴から本日（JST）分のみを抽出する。無効な now は本日なし（graceful empty）。 */
function filterToday(logs: readonly ReceptionLog[], now: Date): ReceptionLog[] {
  return filterWithinJstDays(logs, now, 1);
}

/**
 * 期間プリセット（本日/直近7日/直近30日）ごとの体験 KPI を集計する (issue #319 AC「期間指定」)。
 * 各期間で JST 暦日境界に絞ったログへ同一の純関数 `summarizeExperience` を適用する
 * （分子/分母の定義を期間間で食い違わせない）。
 */
export function summarizeExperiencePeriods(
  logs: readonly ReceptionLog[],
  now: Date = new Date(),
): ExperiencePeriodKpi[] {
  return EXPERIENCE_PERIOD_DEFS.map(({ key, label, days }) => ({
    key,
    label,
    days,
    kpi: summarizeExperience(filterWithinJstDays(logs, now, days)),
  }));
}

/**
 * 期間プリセット（本日/直近7日/直近30日）ごとの満足度フィードバック集計を導く
 * (issue #320 AC「期間指定で見られる」)。体験 KPI と同一のプリセット定義・JST 境界フィルタ
 * （`filterWithinJstDays`）を使い回し、期間の定義を食い違わせない。
 */
export function summarizeSatisfactionPeriods(
  logs: readonly ReceptionLog[],
  now: Date = new Date(),
): SatisfactionPeriodKpi[] {
  return EXPERIENCE_PERIOD_DEFS.map(({ key, label, days }) => ({
    key,
    label,
    days,
    summary: summarizeSatisfaction(filterWithinJstDays(logs, now, days)),
  }));
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
  // 体験 KPI は期間プリセット（本日/直近7日/直近30日）を JST 暦日境界で集計する（#254/#319）。
  // `experience` は本日プリセットと同値（後方互換：既存 UI／rolling deploy 中の旧クライアント向け）。
  const experiencePeriods = summarizeExperiencePeriods(logs, now);
  const experience = experiencePeriods[0]?.kpi ?? summarizeExperience(filterToday(logs, now));
  // 満足度フィードバックも同じ期間プリセットで集計する（#320）。
  const satisfactionPeriods = summarizeSatisfactionPeriods(logs, now);
  const satisfaction = satisfactionPeriods[0]?.summary ?? summarizeSatisfaction(filterToday(logs, now));
  return {
    status: deriveOverallStatus(today, devices),
    today,
    devices,
    recentCalls: recentCalls(logs),
    usageCost,
    experience,
    experiencePeriods,
    satisfaction,
    satisfactionPeriods,
  };
}
