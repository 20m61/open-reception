import { describe, expect, it } from 'vitest';
import { STATUS_META } from './ui/tokens';
import { enablementState, siteStatusState, tenantStatusState } from './state-vocabulary';

/**
 * 状態語彙の正本 (#898 / 課題 11)。
 *
 * ここで縛るのは**不変条件**であって「有効は『有効』と書く」という写経ではない。
 * 語彙表そのものを書き写したテストは、表を書き換える変異を kill できない
 * （表とテストが同じ誤りを共有する）。
 */

const AXES = [
  { name: 'enablement', on: () => enablementState(true), off: () => enablementState(false) },
  { name: 'site', on: () => siteStatusState('active'), off: () => siteStatusState('suspended') },
  { name: 'tenant', on: () => tenantStatusState('active'), off: () => tenantStatusState('suspended') },
] as const;

describe('状態語彙', () => {
  it.each(AXES)('$name: 肯定側は ok、否定側は stopped へ写る', ({ on, off }) => {
    expect(on().status).toBe('ok');
    expect(off().status).toBe('stopped');
  });

  it.each(AXES)('$name: 色は共有バッジと同じ出所から来る', ({ on, off }) => {
    /*
     * 各画面はインラインの色つきテキストで描く。色を独自に決めると、同じ状態が
     * バッジでは success・テキストでは danger という**バッジとテキストの食い違い**が
     * 生まれる（`KiosksManager` は実際に無効を danger で描いていた）。
     */
    expect(on().color).toBe(STATUS_META.ok.color);
    expect(off().color).toBe(STATUS_META.stopped.color);
  });

  it.each(AXES)('$name: 肯定と否定で別の言葉になる', ({ on, off }) => {
    expect(on().label).not.toBe(off().label);
    expect(on().label).not.toBe('');
    expect(off().label).not.toBe('');
  });

  it('無効を「失効」と言わない（値は enabled であって期限ではない）', () => {
    expect(enablementState(false).label).not.toContain('失効');
    expect(enablementState(true).label).not.toContain('失効');
  });

  it('拠点とテナントは同じ言葉を使う（同じ形の状態を別々に読ませない）', () => {
    expect(siteStatusState('active').label).toBe(tenantStatusState('active').label);
    expect(siteStatusState('suspended').label).toBe(tenantStatusState('suspended').label);
  });

  it('enabled 軸は status 軸と別の言葉を持つ（「有効」と「稼働中」を混ぜない）', () => {
    expect(enablementState(true).label).not.toBe(siteStatusState('active').label);
  });
});
