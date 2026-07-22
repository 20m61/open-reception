/**
 * ServiceOperatingPolicy ドメイン型 (issue #367 「営業時間外UX」)。
 *
 * epic #367 本文は複数サービス（realtime-conversation/stt/vonage 等）を個別に運用モード制御する
 * 大きなモデルを提案しているが、本 increment は「kiosk 受付が営業時間内かどうか」を判定する
 * 最小スコープに絞る（営業時間外 UX と #4 の新規発信拒否のみ）。サービス別 registry / Runtime
 * Resource / Reconciler 等（Increment 1-3 の全体）は本 increment の対象外。
 *
 * テナント/サイト単位に**1件**のポリシーを持つ（RoutingPolicy のような複数件リストではない）。
 */
import type { Weekday } from './tz';

export type { Weekday };

/**
 * 曜日内の 1 営業時間帯。`start`/`end` は "HH:mm"（24h）。
 * `crossesMidnight: true` のとき、`end` は**翌日**の時刻を指す（例: 22:00-02:00 の深夜営業）。
 * 逆転区間（`crossesMidnight` 未指定/false なのに end <= start）は検証で拒否する
 * （`validatePolicyInput`）— 日跨ぎは明示フラグで区別し、暗黙の逆転とは混同しない。
 */
export type TimeRange = {
  start: string;
  end: string;
  crossesMidnight?: boolean;
};

/**
 * 単発の休業日/特別営業日 (`date`: "YYYY-MM-DD")。
 * `closed: true` は終日休業。`closed: false` かつ `ranges` 指定は、その日だけ通常の曜日別営業時間を
 * 上書きする（臨時営業・短縮営業）。
 */
export type OperatingException = {
  date: string;
  closed: boolean;
  ranges?: TimeRange[];
};

/**
 * テナント/サイト単位の営業時間ポリシー。`version` は楽観ロック用の単調増加カウンタ
 * （epic #367 本文の型に準拠、更新のたびに +1）。
 */
export type ServiceOperatingPolicy = {
  tenantId: string;
  siteId: string;
  /** IANA タイムゾーン名。既定 'Asia/Tokyo'（`DEFAULT_TIMEZONE`）。 */
  timezone: string;
  /** 曜日別営業時間帯（複数区間可）。キー無し/空配列はその曜日終日休業。 */
  weeklySchedule: Partial<Record<Weekday, TimeRange[]>>;
  /** 固定休業日（"MM-DD"、毎年一致。例: 年末年始 '01-01'）。 */
  fixedHolidays: string[];
  /** 単発の休業日/特別営業日。 */
  exceptionDates: OperatingException[];
  /**
   * 営業時間外表示に出す緊急連絡導線ラベル（例: 「警備室内線」）。実電話番号等の PII/機微値は
   * 含めない（`.claude/rules/pii-secret-minimization.md`、`@/domain/kiosk/operating-status.ts` と同方針）。
   */
  emergencyContactLabel?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
};

/** `evaluateOperatingStatus` の判定結果。 */
export type OperatingEvaluation = {
  state: 'open' | 'closed';
  /** closed のときのみ、次回オープン予定時刻（ISO8601）。判定できない場合は未設定。 */
  reopenAt?: string;
};

/** バリデーション issue（フィールド単位でフロントに返す）。 */
export type PolicyValidationIssue = {
  field: string;
  message: string;
};
