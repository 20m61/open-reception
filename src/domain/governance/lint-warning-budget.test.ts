import { describe, expect, it } from 'vitest';
import {
  LINT_WARNING_BUDGET,
  countWarningsByRule,
  diffLintWarningBudget,
  eslintJsonHasErrors,
  lintWarningBudgetTotal,
} from './lint-warning-budget';

describe('lintWarningBudgetTotal', () => {
  it('正本の合計は 74（#813 の総数 ratchet を内訳の和として引き継ぐ）', () => {
    expect(lintWarningBudgetTotal()).toBe(74);
  });
});

describe('diffLintWarningBudget', () => {
  it('正本どうしは差分無し', () => {
    expect(diffLintWarningBudget(LINT_WARNING_BUDGET)).toEqual([]);
  });

  /**
   * 🔴 **#843 が止める交換。** 総数は 74 のまま、受付導線に set-state-in-effect を
   * 3 件足して unused-vars を 3 件消す。`--max-warnings 74` だけだと緑。
   */
  it('総数が同じでもルール別の 3 件交換は落ちる', () => {
    const swapped = {
      'react-hooks/set-state-in-effect': 57,
      '@typescript-eslint/no-unused-vars': 16,
      '@next/next/no-img-element': 1,
    };
    expect(lintWarningBudgetTotal(swapped)).toBe(74);
    expect(diffLintWarningBudget(swapped)).toEqual([
      { ruleId: '@typescript-eslint/no-unused-vars', expected: 19, actual: 16 },
      { ruleId: 'react-hooks/set-state-in-effect', expected: 54, actual: 57 },
    ]);
  });

  it('予算に無いルールの warning は 0 件が期待（新規ルールの黙った増加を落とす）', () => {
    const extra = {
      ...LINT_WARNING_BUDGET,
      'react-hooks/exhaustive-deps': 3,
    };
    expect(diffLintWarningBudget(extra)).toEqual([
      { ruleId: 'react-hooks/exhaustive-deps', expected: 0, actual: 3 },
    ]);
  });

  it('1 ルールでも減らしたら落ちる（下げ忘れ防止＝下界）', () => {
    const lowered = {
      ...LINT_WARNING_BUDGET,
      '@typescript-eslint/no-unused-vars': 18,
    };
    expect(diffLintWarningBudget(lowered)).toEqual([
      { ruleId: '@typescript-eslint/no-unused-vars', expected: 19, actual: 18 },
    ]);
  });
});

describe('countWarningsByRule / eslintJsonHasErrors', () => {
  it('severity 1 だけをルール別に数え、error は予算に混ぜない', () => {
    const json = [
      {
        messages: [
          { severity: 1, ruleId: 'react-hooks/set-state-in-effect' },
          { severity: 1, ruleId: 'react-hooks/set-state-in-effect' },
          { severity: 1, ruleId: '@typescript-eslint/no-unused-vars' },
          { severity: 2, ruleId: 'react-hooks/exhaustive-deps' },
        ],
      },
    ];
    expect(countWarningsByRule(json)).toEqual({
      'react-hooks/set-state-in-effect': 2,
      '@typescript-eslint/no-unused-vars': 1,
    });
    expect(eslintJsonHasErrors(json)).toBe(true);
  });

  it('ruleId が無い warning は (no-rule) に畳む（黙って消さない）', () => {
    expect(countWarningsByRule([{ messages: [{ severity: 1, ruleId: null }] }])).toEqual({
      '(no-rule)': 1,
    });
  });

  it('messages が無いファイルは 0 件（空の世界で空虚に通さないための下界は diff 側）', () => {
    expect(countWarningsByRule([{}])).toEqual({});
    expect(eslintJsonHasErrors([{}])).toBe(false);
  });
});
