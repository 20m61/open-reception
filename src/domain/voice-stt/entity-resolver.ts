/**
 * partial からの担当者・部門 Entity 解決 (issue #370)。
 *
 * 設計方針:
 * - STT が返す文字列と完全一致だけで担当者/部門を確定しない。`src/domain/staff/search.ts`
 *   （issue #322）のあいまい検索 tier（exact/prefix/contains/fuzzy）をそのまま再利用し、
 *   tier を Entity confidence（0..1）へ写像する。**改変せず利用**する（issue #370 指示）。
 * - STT confidence（音声認識としての確信度）と Entity confidence（名寄せとしての確信度）は
 *   別軸で保持する。呼び出し側が両方を見て、低信頼時は確認へ遷移できるようにする
 *   （`decideEntityConfirmation`）。
 * - 拠点・予約・QR・当日予定を使った重み付けは `applyContextBoost` として**境界だけ**設計する。
 *   実データ（予約・QR デコード結果）との配線は本増分のスコープ外（Kiosk 配線は他トラック）。
 */
import { searchStaffScored, type MatchTier } from '@/domain/staff/search';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';

export type EntityCandidateKind = 'staff' | 'department' | 'purpose' | 'other';

export type EntityCandidate = {
  id: string;
  kind: EntityCandidateKind;
  displayName: string;
  /** Entity resolver 独自の確信度（0..1）。STT confidence とは別軸（issue #370 要件）。 */
  entityConfidence: number;
};

export type EntityResolutionResult = {
  query: string;
  top1: EntityCandidate | null;
  /** score 降順、最大 3 件（#365 `entity.resolved` の Top3 契約と揃える）。 */
  top3: EntityCandidate[];
};

/**
 * `search.ts` の tier → Entity confidence の初期写像。
 * 実データでの再調整は #65（実機 UAT）で行う想定の暫定値。
 */
const TIER_CONFIDENCE: Record<MatchTier, number> = {
  exact: 1,
  prefix: 0.8,
  contains: 0.6,
  fuzzy: 0.35,
};

/** partial の投機的解決を始めてよい最小文字数（短すぎる接頭辞での無駄な検索を避ける）。 */
const MIN_SPECULATIVE_QUERY_CHARS = 2;

/** partial テキストが投機的な Entity 解決を始めるに足る長さかどうか。 */
export function shouldSpeculativelyResolve(partialText: string): boolean {
  return partialText.trim().length >= MIN_SPECULATIVE_QUERY_CHARS;
}

export function resolveStaffEntities(staff: ReadonlyArray<Staff>, query: string): EntityCandidate[] {
  const enabled = staff.filter((s) => s.enabled);
  return searchStaffScored(enabled, query).map((m) => ({
    id: m.item.id,
    kind: 'staff' as const,
    displayName: m.item.displayName,
    entityConfidence: TIER_CONFIDENCE[m.tier],
  }));
}

export function resolveDepartmentEntities(
  departments: ReadonlyArray<Department>,
  query: string,
): EntityCandidate[] {
  const enabled = departments.filter((d) => d.enabled);
  const searchable = enabled.map((d) => ({ ref: d, displayName: d.name, kana: d.kana, aliases: [] as string[] }));
  return searchStaffScored(searchable, query).map((m) => ({
    id: m.item.ref.id,
    kind: 'department' as const,
    displayName: m.item.ref.name,
    entityConfidence: TIER_CONFIDENCE[m.tier],
  }));
}

/** merge の対象となる directory の最小形。 */
export type EntityDirectory = {
  staff: ReadonlyArray<Staff>;
  departments: ReadonlyArray<Department>;
};

/**
 * 担当者・部門の候補を統合し、Top1/Top3 を返す（score 降順）。
 * `#365` の `entity.resolved` イベント契約（candidates は score 降順）と直接互換な形。
 */
export function resolveEntities(directory: EntityDirectory, query: string): EntityResolutionResult {
  const merged = [...resolveStaffEntities(directory.staff, query), ...resolveDepartmentEntities(directory.departments, query)];
  const sorted = merged.sort((a, b) => b.entityConfidence - a.entityConfidence);
  const top3 = sorted.slice(0, 3);
  return { query, top1: top3[0] ?? null, top3 };
}

/**
 * 拠点・予約・QR・当日予定による候補重み付けの**境界**。
 *
 * 本増分では実データ（予約・QR デコード結果・当日予定）との配線は行わず、呼び出し側が
 * 明示的に渡した ID 集合との一致だけを見る純関数として境界を定義する。将来、予約/QR/当日予定
 * ドメインが確定した時点で、この関数の呼び出し元を差し替えるだけで済むようにする。
 *
 * ブースト幅は加算的（`boostConfig` の各項）で、`entityConfidence` は 1 を超えない。
 */
export type EntityResolutionContext = {
  siteId?: string;
  /** 予約から見て今日この拠点に来訪予定の担当者 ID。 */
  reservationStaffIds?: readonly string[];
  /** 来訪者が提示した QR が指す担当者 ID（存在すれば強いシグナル）。 */
  qrStaffId?: string;
  /** 当日のスケジュールから出社が確認できている担当者 ID。 */
  todaysScheduleStaffIds?: readonly string[];
};

export type EntityContextBoostConfig = {
  reservationBoost: number;
  qrBoost: number;
  todaysScheduleBoost: number;
};

export const DEFAULT_ENTITY_CONTEXT_BOOST_CONFIG: EntityContextBoostConfig = {
  reservationBoost: 0.15,
  qrBoost: 0.25,
  todaysScheduleBoost: 0.1,
};

export function applyContextBoost(
  candidates: readonly EntityCandidate[],
  context: EntityResolutionContext,
  boostConfig: EntityContextBoostConfig = DEFAULT_ENTITY_CONTEXT_BOOST_CONFIG,
): EntityCandidate[] {
  const reservationSet = new Set(context.reservationStaffIds ?? []);
  const scheduleSet = new Set(context.todaysScheduleStaffIds ?? []);

  return candidates.map((c) => {
    if (c.kind !== 'staff') return c;
    let boost = 0;
    if (context.qrStaffId === c.id) boost += boostConfig.qrBoost;
    if (reservationSet.has(c.id)) boost += boostConfig.reservationBoost;
    if (scheduleSet.has(c.id)) boost += boostConfig.todaysScheduleBoost;
    if (boost === 0) return c;
    return { ...c, entityConfidence: Math.min(1, c.entityConfidence + boost) };
  });
}

/** 低信頼時の確認遷移理由。 */
export const STT_ENTITY_CONFIRMATION_REASONS = [
  'low_stt_confidence',
  'low_entity_confidence',
  'ambiguous_candidates',
] as const;

export type SttEntityConfirmationReason = (typeof STT_ENTITY_CONFIRMATION_REASONS)[number];

/**
 * 発信前確認へ遷移させるための中立イベント（issue #370「低信頼時は自動発信せず確認へ遷移する」）。
 * UI 配線・実際の発信操作はスコープ外 — ここでは「確認が必要かどうか」の判定だけを持つ。
 */
export type SttEntityConfirmationEvent = {
  type: 'sttEntityConfirmationRequired';
  reason: SttEntityConfirmationReason;
  /** 判定に使った STT confidence（Entity confidence とは別軸で残す）。 */
  sttConfidence: number;
  top1: EntityCandidate | null;
  t: number;
};

export type EntityResolutionThresholds = {
  /** これ未満の STT confidence は Entity confidence に関わらず確認必須。 */
  minSttConfidence: number;
  /** top1 の Entity confidence がこれ未満なら確認必須。 */
  minEntityConfidence: number;
  /** top1 と top2 の Entity confidence 差がこれ未満なら「もしかして」扱いで確認必須。 */
  minMarginOverSecond: number;
};

export const DEFAULT_ENTITY_RESOLUTION_THRESHOLDS: EntityResolutionThresholds = {
  minSttConfidence: 0.6,
  minEntityConfidence: 0.5,
  minMarginOverSecond: 0.1,
};

/**
 * STT confidence と Entity confidence（Top1/Top2）を見て、確認画面への遷移が必要かどうかを
 * 判定する。自動発信してよい（= 確認不要）場合は `null` を返す。
 *
 * 優先順位: STT confidence が低い場合が最優先（そもそも聞き取れていない）→ 候補なし/低信頼 →
 * 僅差の曖昧な候補、の順に評価する。
 */
export function decideEntityConfirmation(
  sttConfidence: number,
  top3: readonly EntityCandidate[],
  thresholds: EntityResolutionThresholds = DEFAULT_ENTITY_RESOLUTION_THRESHOLDS,
  t: number,
): SttEntityConfirmationEvent | null {
  const top1 = top3[0] ?? null;

  if (sttConfidence < thresholds.minSttConfidence) {
    return { type: 'sttEntityConfirmationRequired', reason: 'low_stt_confidence', sttConfidence, top1, t };
  }
  if (!top1 || top1.entityConfidence < thresholds.minEntityConfidence) {
    return { type: 'sttEntityConfirmationRequired', reason: 'low_entity_confidence', sttConfidence, top1, t };
  }
  const top2 = top3[1];
  if (top2 && top1.entityConfidence - top2.entityConfidence < thresholds.minMarginOverSecond) {
    return { type: 'sttEntityConfirmationRequired', reason: 'ambiguous_candidates', sttConfidence, top1, t };
  }
  return null;
}
