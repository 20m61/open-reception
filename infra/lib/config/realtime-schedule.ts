/**
 * リアルタイム会話 EC2 基盤の営業時間判定 (issue #366 Phase 0, `docs/adr/0003-*.md` ADR-002)。
 *
 * `RealtimeReconcilerFunction`（Lambda ハンドラ, `infra/lambda/realtime-reconciler/handler.ts`）と
 * infra テストの両方から参照する純粋関数。AWS SDK に依存しないため Lambda 側の実装から切り出し、
 * ユニットテストで境界値（開始/終了時刻ちょうど、UTC⇄JST の日付またぎ）を固定する。
 *
 * 初期値は DynamoDB 連携前の固定時刻ポリシー（issue #366 本文の「初期ポリシー」節）。
 * 営業時間を DynamoDB の ServiceOperatingPolicy から読む対応は後続 increment（#367 統合待ち）。
 */

/** Asia/Tokyo は UTC+9 固定（DST 無し）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface BusinessHoursWindow {
  /** 現状 Asia/Tokyo 固定。他 timezone 対応は非スコープ（issue #366 非スコープ節）。 */
  readonly timezone: 'Asia/Tokyo';
  /** 起動時刻（JST, 0-23）。 */
  readonly startHour: number;
  /** 停止時刻（JST, 0-23）。startHour より大きい前提（日付をまたぐ営業時間は未対応）。 */
  readonly stopHour: number;
}

/** UTC の Date を JST の時刻（0-23）に変換する。 */
export function toJstHour(nowUtc: Date): number {
  return new Date(nowUtc.getTime() + JST_OFFSET_MS).getUTCHours();
}

/**
 * 指定時刻(UTC)が営業時間内(`startHour <= JST時 < stopHour`)かを判定する。
 * 半開区間: startHour ちょうどは営業時間内、stopHour ちょうどは営業時間外（停止済み）。
 */
export function isWithinBusinessHours(nowUtc: Date, window: BusinessHoursWindow): boolean {
  const hour = toJstHour(nowUtc);
  return hour >= window.startHour && hour < window.stopHour;
}

/** Reconciler が ASG へ設定すべき DesiredCapacity（MVP: 単一インスタンスの 0/1 のみ）。 */
export function desiredCapacityFor(nowUtc: Date, window: BusinessHoursWindow): 0 | 1 {
  return isWithinBusinessHours(nowUtc, window) ? 1 : 0;
}
