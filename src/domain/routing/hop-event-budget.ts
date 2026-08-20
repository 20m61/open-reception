/**
 * イベント上限を「通話ごと」ではなく**取次全体**で数える (#646)。
 *
 * ## なぜ
 *
 * 2 手目は新しい `providerCallId` を持つので、相関は**新しいレコード**になる
 * （相関のキーが `providerCallId`。`call-correlation.ts`）。`eventCount` を相関側から
 * 読んでいると、**新レコードで必ず 0 にリセットされる** —— 上限が
 * `1 通話 100 イベント × 最大 10 hop = 実質 1000` まで緩む。
 *
 * webhook は**認証を持たない公開エンドポイント**で、この上限は `ledger` が DynamoDB の
 * item サイズ上限（400KB）へ育つのを止めるために置かれている（`webhook-advance.ts`）。
 * 発信を繋ぐ前にここを固める。
 *
 * `hops` と `ledger` は既に `RoutingPosition` に載っていて position ごと引き継げば取次全体で
 * 効く。**`eventCount` も同じ場所へ載せる**（ユーザー判断 / 2026-08-20）。
 *
 * ## 互換性
 *
 * `RoutingPosition.eventCount` は**任意フィールド**で、読み側（`eventBudgetOf`）は
 * 相関側の値へ倒す既定値を持つ。既存フィールドの意味・型・必須性は変えていない。
 * `.claude/rules/opus5-autonomous-loop.md` の「永続スキーマも互換なら進めてよい」の
 * 3 条件を満たす（テストで固定済み）。
 */
import type { RoutingPosition } from './resumable';

/**
 * この取次でこれまでに処理したイベント数。
 *
 * @param fallback 相関レコード側の値（`correlation.eventCount`）。
 *   `position` に無い**旧レコード**のための退避先で、TTL 6 時間で入れ替わるまで使われる。
 */
export function eventBudgetOf(position: RoutingPosition, fallback: number | undefined): number {
  // 🔴 `||` で書かないこと。position の 0 を「未設定」と取り違えて
  // 相関側へ倒れる—— 2 手目の間に一度もイベントを見ていない瞬間に上限が滅ぶ。0 は正当な値。
  return position.eventCount ?? fallback ?? 0;
}

/** 次の手へ引き継げるよう position へ書き戻す。 */
export function withEventBudget(position: RoutingPosition, eventCount: number): RoutingPosition {
  return { ...position, eventCount };
}
