/**
 * Negative security test の判定 (spec §7)。
 *
 * `scripts/aws-negative-tests.ts` は AWS 認証情報が無いと動かず、本サイクルでは
 * 一度も実走しない。実走しないコードをテスト無しで置かないため、判定部分を
 * 純関数として切り出す。副作用（`aws` CLI の呼び出し）は一切持たない。
 */

export type Outcome = 'allowed' | 'denied' | 'unknown';

/** 拒否シグナル。大小文字を無視する。 */
const DENY_PATTERN = /AccessDenied|not authorized|explicit deny/i;

/**
 * `aws` CLI の stderr を判定する。
 *
 * **`unknown` は「まだ確認していない」を表す。denied を推測で埋めない。**
 * 空文字（stderr を取得できなかった／エラーメッセージが無かった）も、拒否シグナルを
 * 含まない他のエラー（ネットワーク断・スロットリング等）も `unknown` に落ちる。
 * [[空文字は「問題なし」ではない]] の教訓と同じ型: 判定材料が無いことを
 * 都合よく「denied だった」に読み替えない。
 */
export function classifyAwsError(stderr: string): 'denied' | 'unknown' {
  if (stderr === '') return 'unknown';
  return DENY_PATTERN.test(stderr) ? 'denied' : 'unknown';
}

export type NegativeTestResult = {
  readonly id: string;
  readonly expected: 'allowed' | 'denied';
  readonly actual: Outcome;
};

export type NegativeTestSummary = { readonly failed: number };

/**
 * `actual === expected` の完全一致でのみ PASS とする。
 *
 * **`unknown` は決して PASS にならない**: `expected` が `'denied'` でも `'allowed'` でも、
 * `actual` が `'unknown'` なら不一致として failed に数える。判定不能を PASS に丸めると、
 * 実は Deny が効いていないケースを見逃す（`--strict` の思想と同じ: 測れていないものを
 * PASS にしない）。
 */
export function summarizeNegativeTests(results: ReadonlyArray<NegativeTestResult>): NegativeTestSummary {
  const failed = results.filter((r) => r.actual !== r.expected).length;
  return { failed };
}
