/**
 * lint warning の **ルール別** 予算 (#843)。
 *
 * #813 は `--max-warnings 74` で総数の増加を止めたが、内訳は見ていなかった。
 * `@typescript-eslint/no-unused-vars` を 3 件消して `react-hooks/set-state-in-effect` を
 * 受付導線に 3 件足す交換は 74 のまま緑になる。ここが内訳の正本で、
 * `scripts/lint-with-budget.ts` が ESLint JSON と突き合わせる。
 *
 * 件数を下げたらこの表も一緒に下げる。上げるのは「なぜ増やすのか」を PR に書いたときだけ。
 * exact match なので下げ忘れは赤になる（総数の `--max-warnings` より強い）。
 */

/** ルール ID → 許容する warning 件数。載っていないルールの warning は 0 件が期待。 */
export const LINT_WARNING_BUDGET: Readonly<Record<string, number>> = {
  // #873 で `CallRoutesManager`（旧・呼び出しルート画面）を削除し 54 → 53 へ下がった。
  'react-hooks/set-state-in-effect': 53,
  '@typescript-eslint/no-unused-vars': 19,
  '@next/next/no-img-element': 1,
};

export type LintWarningBudgetViolation = {
  ruleId: string;
  expected: number;
  actual: number;
};

export type EslintJsonMessage = {
  severity?: number;
  ruleId?: string | null;
};

export type EslintJsonFile = {
  messages?: readonly EslintJsonMessage[];
};

export function lintWarningBudgetTotal(
  budget: Readonly<Record<string, number>> = LINT_WARNING_BUDGET,
): number {
  return Object.values(budget).reduce((sum, n) => sum + n, 0);
}

/** severity 1（warning）だけをルール別に数える。error は別経路で落とす。 */
export function countWarningsByRule(
  eslintJson: readonly EslintJsonFile[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of eslintJson) {
    for (const message of file.messages ?? []) {
      if (message.severity !== 1) continue;
      const ruleId = message.ruleId ?? '(no-rule)';
      counts[ruleId] = (counts[ruleId] ?? 0) + 1;
    }
  }
  return counts;
}

export function eslintJsonHasErrors(eslintJson: readonly EslintJsonFile[]): boolean {
  return eslintJson.some((file) => (file.messages ?? []).some((m) => m.severity === 2));
}

/**
 * 実測と予算の差分。増えても減っても、載っていないルールが現れても落ちる。
 * 総数が一致していても内訳が違えば violation になる（#843 が止める交換）。
 */
export function diffLintWarningBudget(
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>> = LINT_WARNING_BUDGET,
): LintWarningBudgetViolation[] {
  const ruleIds = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const violations: LintWarningBudgetViolation[] = [];
  for (const ruleId of [...ruleIds].sort()) {
    const expectedCount = expected[ruleId] ?? 0;
    const actualCount = actual[ruleId] ?? 0;
    if (expectedCount !== actualCount) {
      violations.push({ ruleId, expected: expectedCount, actual: actualCount });
    }
  }
  return violations;
}

export function formatLintWarningBudgetViolations(
  violations: readonly LintWarningBudgetViolation[],
): string {
  return violations
    .map((v) => `  ${v.ruleId}: 期待 ${v.expected} 件 / 実際 ${v.actual} 件`)
    .join('\n');
}
