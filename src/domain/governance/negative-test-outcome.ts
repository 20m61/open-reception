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
 * `aws` CLI の stderr を判定する。**「対象アクションを直接実試行した」呼び出し
 * （`aws()` = N2/N3/N4/N5/N6/N7）専用。** ここでの AccessDenied は「試した操作そのもの」が
 * denied だったことを意味する。
 *
 * **`unknown` は「まだ確認していない」を表す。denied を推測で埋めない。**
 * 空文字列は `DENY_PATTERN` のどの分岐にも一致しないため自然に `unknown` になる
 * （明示的な早期リターンは無くてもよい。[[空文字は「問題なし」ではない]] の性質は
 * 下のテストが regex 経由で固定する）。拒否シグナルを含まない他のエラー
 * （ネットワーク断・スロットリング等）も同様に `unknown` に落ちる。判定材料が無いことを
 * 都合よく「denied だった」に読み替えない。
 *
 * 🔴 **`simulate()`（`iam:SimulatePrincipalPolicy` の呼び出し）の catch には使わない。**
 * そちらは `classifySimulationError` を使う（意味が違う。理由は下記コメント参照）。
 */
export function classifyAwsError(stderr: string): 'denied' | 'unknown' {
  return DENY_PATTERN.test(stderr) ? 'denied' : 'unknown';
}

/**
 * `simulate()`（`iam:SimulatePrincipalPolicy` の呼び出し）が例外を投げたときの判定。
 *
 * 🔴 **CRITICAL: `classifyAwsError` を流用しない。** `aws()` では「呼び出し自体が
 * AccessDenied」＝「試した操作（対象アクション）が denied」だが、`simulate()` の例外は
 * 「`SimulatePrincipalPolicy` という**別の** API 呼び出しができなかった」だけであり、
 * 評価対象のアクション（例: `dynamodb:DeleteTable`）が denied かどうかについて
 * **何も語らない**。ここで `classifyAwsError(stderr)` を呼ぶと、
 * `SimulatePrincipalPolicy` 自体への AccessDenied（＝評価不能）が「対象アクションは
 * denied だった」に化けてしまい、`iam:SimulatePrincipalPolicy` 権限を持たない
 * principal で実行すると S1〜S10 が**すべて見かけ上 PASS**になる
 * （2026-08-12 レビューで発見された CRITICAL）。
 *
 * 常に `'unknown'` を返す。stderr の中身に関わらず、である。
 */
export function classifySimulationError(_stderr: string): 'unknown' {
  return 'unknown';
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

export type ExecutionScope = 'live' | 'simulate' | 'all';

/**
 * `--live-only` / `--simulate-only` の相互排他を判定する (spec §7 / Important 5b)。
 *
 * S 系（`SimulatePrincipalPolicy`）は `iam:SimulatePrincipalPolicy` 権限を持つ
 * 人間の Admin 環境からの runbook 実行を前提とする。`OpenReceptionClaudeDeploy-dev`
 * にその権限を与えるべきではないため、`scripts/aws-cloud-deploy.sh` の
 * `collect_observation` は常に `--live-only` を渡し、S 系はスキップする。
 *
 * 両方同時指定は矛盾する要求（「live だけ」と「simulate だけ」を同時に言っている）
 * なので `null` を返し、呼び出し側に非ゼロ終了させる。
 */
export function resolveExecutionScope(simulateOnly: boolean, liveOnly: boolean): ExecutionScope | null {
  if (simulateOnly && liveOnly) return null;
  if (simulateOnly) return 'simulate';
  if (liveOnly) return 'live';
  return 'all';
}
