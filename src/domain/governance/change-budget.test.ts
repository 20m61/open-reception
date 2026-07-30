import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANGE_BUDGET,
  evaluateChangeBudget,
  resolveKillSwitch,
  type ChangeStat,
} from './change-budget';

/**
 * 1 ループの変更量上限と kill switch (#424 増分 4)。
 *
 * **止める資格が違うので扱いを分ける**:
 *  - kill switch … 人間が明示的に armed にしたときだけ立つ。偽陽性が原理的に無いので FAIL させる。
 *  - 変更量上限 … 大きい変更が自動的に悪いわけではない。**報告のみ**。FAIL にすると override が
 *    習慣化して、change-risk で避けたのと同じ「赤を無視する習慣」を作る。
 */
const stat = (files: number, insertions: number, deletions: number): ChangeStat => ({
  files,
  insertions,
  deletions,
});

describe('resolveKillSwitch: ループの緊急停止', () => {
  it('何も指定されていなければ止まらない', () => {
    expect(resolveKillSwitch({}).halted).toBe(false);
  });

  it('env が立っていれば止まる', () => {
    const verdict = resolveKillSwitch({ env: '1' });
    expect(verdict.halted).toBe(true);
    expect(verdict.source).toBe('env');
  });

  it('停止ファイルが在れば止まる。中身は理由として出す', () => {
    const verdict = resolveKillSwitch({ fileContent: '  本番調査中につき停止  ' });
    expect(verdict.halted).toBe(true);
    expect(verdict.source).toBe('file');
    expect(verdict.reason).toBe('本番調査中につき停止');
  });

  it('空の停止ファイルでも止まる（理由が書かれていないことは解除条件ではない）', () => {
    const verdict = resolveKillSwitch({ fileContent: '' });
    expect(verdict.halted).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('env の偽値では止まらない（未設定と空文字・0・false を同じに扱う）', () => {
    for (const value of ['', '0', 'false']) {
      expect(resolveKillSwitch({ env: value }).halted).toBe(false);
    }
  });

  it('両方在れば file を理由の出どころにする（人が書いた文字列の方が情報量が多い）', () => {
    const verdict = resolveKillSwitch({ env: '1', fileContent: '理由' });
    expect(verdict.halted).toBe(true);
    expect(verdict.source).toBe('file');
    expect(verdict.reason).toBe('理由');
  });
});

describe('evaluateChangeBudget: 1 ループの変更量', () => {
  it('既定の上限内なら超過なし', () => {
    const verdict = evaluateChangeBudget(stat(9, 235, 82), DEFAULT_CHANGE_BUDGET);
    expect(verdict.exceeded).toEqual([]);
    expect(verdict.withinBudget).toBe(true);
  });

  it('ファイル数の超過を報告する', () => {
    const verdict = evaluateChangeBudget(stat(999, 10, 0), DEFAULT_CHANGE_BUDGET);
    expect(verdict.exceeded).toContain('files');
    expect(verdict.withinBudget).toBe(false);
  });

  it('行数は追加と削除の合計で見る（大量削除も 1 ループの変更量）', () => {
    const limits = { maxFiles: 100, maxChangedLines: 100 };
    expect(evaluateChangeBudget(stat(1, 60, 60), limits).exceeded).toContain('lines');
    expect(evaluateChangeBudget(stat(1, 0, 101), limits).exceeded).toContain('lines');
  });

  it('ちょうど上限は超過ではない（境界は含む）', () => {
    const limits = { maxFiles: 3, maxChangedLines: 10 };
    expect(evaluateChangeBudget(stat(3, 5, 5), limits).withinBudget).toBe(true);
  });

  it('両方超えたら両方報告する（片方で止めない）', () => {
    const limits = { maxFiles: 1, maxChangedLines: 1 };
    expect(evaluateChangeBudget(stat(5, 50, 0), limits).exceeded).toEqual(['files', 'lines']);
  });

  it('実測値を verdict に含める（報告のみなので、読む側が判断できる材料を残す）', () => {
    const verdict = evaluateChangeBudget(stat(4, 30, 12), DEFAULT_CHANGE_BUDGET);
    expect(verdict.files).toBe(4);
    expect(verdict.changedLines).toBe(42);
    expect(verdict.limits).toEqual(DEFAULT_CHANGE_BUDGET);
  });

  it('変更ゼロでも壊れない', () => {
    expect(evaluateChangeBudget(stat(0, 0, 0), DEFAULT_CHANGE_BUDGET).withinBudget).toBe(true);
  });
});
