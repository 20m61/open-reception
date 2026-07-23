/**
 * 取次イベントの冪等台帳 (issue #374)。
 *
 * Provider webhook は同じイベントを複数回配信しうる（at-least-once）。同じ
 * `(callUuid, providerEventId)` を二重に処理すると取次が余計に 1 手進む・二重発信になるため、
 * Orchestrator は処理済みキーを台帳で覚え、重複イベントを黙って捨てる（冪等境界）。
 *
 * 純粋・イミュータブル。永続台帳（DynamoDB 等）へ載せ替えても境界が同じになるよう、
 * 状態は文字列キーの集合として表す。
 */

/** 処理済みイベントキーの集合（イミュータブル）。 */
export type ProviderEventLedger = ReadonlySet<string>;

/** 空の台帳。 */
export function emptyLedger(): ProviderEventLedger {
  return new Set<string>();
}

/** 冪等キー。1 通話（callUuid）内で Provider イベント（providerEventId）を一意化する。 */
export function idempotencyKey(callUuid: string, providerEventId: string): string {
  return `${callUuid}#${providerEventId}`;
}

export type LedgerRecordResult = {
  /** 記録後の新しい台帳（元は変更しない）。 */
  ledger: ProviderEventLedger;
  /** 既に処理済み（＝今回は無視すべき重複イベント）か。 */
  duplicate: boolean;
};

/**
 * イベントを台帳へ記録する。既出なら `duplicate: true` を返し、台帳は変えない
 * （重複配信を二重処理しないための境界）。
 */
export function recordProviderEvent(
  ledger: ProviderEventLedger,
  callUuid: string,
  providerEventId: string,
): LedgerRecordResult {
  const key = idempotencyKey(callUuid, providerEventId);
  if (ledger.has(key)) return { ledger, duplicate: true };
  const next = new Set(ledger);
  next.add(key);
  return { ledger: next, duplicate: false };
}
