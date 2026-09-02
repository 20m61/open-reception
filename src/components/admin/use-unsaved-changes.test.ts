import { describe, expect, it } from 'vitest';
import { isDirty } from './use-unsaved-changes';

/**
 * dirty 判定の中身 (#912 / 課題 12)。
 *
 * `useUnsavedChanges` は React のフックなので node 環境では回せない。判定そのもの
 * （「いま持っている値が、最後にサーバと同期した値と違うか」）を純関数として実装側から
 * export し、**実物を import して**縛る —— ここに述語を書き写すと、テストと実装が
 * 同じ誤りを共有する。フックの配線は e2e が見る。
 */

const LOADED = { companyName: '株式会社テスト', accentColor: '#38bdf8' };

describe('未保存判定', () => {
  it('読み込み直後は未保存でない', () => {
    expect(isDirty(JSON.stringify(LOADED), LOADED)).toBe(false);
  });

  it('値を変えたら未保存', () => {
    expect(isDirty(JSON.stringify(LOADED), { ...LOADED, companyName: '別の名前' })).toBe(true);
  });

  it('元の値へ戻したら未保存でなくなる', () => {
    /*
     * 「一度でも触ったら dirty」にすると、打ち間違えて直した人まで確認に引っかかる。
     * **値で見る**（フラグを立てっぱなしにしない）。
     */
    const baseline = JSON.stringify(LOADED);
    expect(isDirty(baseline, { ...LOADED, companyName: '別の名前' })).toBe(true);
    expect(isDirty(baseline, { ...LOADED })).toBe(false);
  });

  it('下界: 基準が無い（読み込み前）なら未保存にしない', () => {
    // ここを落とすと、開いた瞬間に「保存していない変更があります」が出る。
    expect(isDirty(null, LOADED)).toBe(false);
  });

  it('下界: 値がまだ無い（読み込み中）なら未保存にしない', () => {
    expect(isDirty(JSON.stringify(LOADED), null)).toBe(false);
  });

  it('ネストした値の変更も拾う', () => {
    const nested = { a11yModesEnabled: { largeText: true, highContrast: false } };
    const baseline = JSON.stringify(nested);
    expect(isDirty(baseline, { a11yModesEnabled: { largeText: true, highContrast: true } })).toBe(true);
  });
});
