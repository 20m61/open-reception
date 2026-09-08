import { describe, expect, it } from 'vitest';
import { asCheckoutResolveResult, asPresentStayList } from './parse';
import type { CheckoutSelfIdSummary, PresentStaySummary } from './logic';

/**
 * 退館フローの応答が**確かめられた形か** (#1004 増分 2)。
 *
 * ここは**来訪者導線**なので、管理画面（増分 1）より害が重い。`as` で通していたため:
 *
 * - `{stays}` が欠けた 200 で `setPresent(undefined)` が走り、次のレンダーの
 *   `present.length` が **TypeError → 退館画面ごと落ちる**（`/kiosk/checkout` に
 *   error boundary は無く、root の `global-error.tsx` が「受付を続けられませんでした」を出す）
 * - `{summary}` が欠けた 200 で `pending.summary.checkedInAt` が throw する ――
 *   **退館の確認画面**、つまり来訪者が「退館する」を押す直前で落ちる
 *
 * 🔴 **必須フィールドの網羅は型から強制する**（増分 1 と同じ手口）。ただしこれが強制するのは
 * **トップレベルのキーの存在だけ**で、入れ子（配列の要素）は別に縛る。
 */

/** `T` の必須キー（任意プロパティを除く）。 */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

const stay = (): PresentStaySummary => ({
  stayId: 's1',
  checkedInAt: '2026-01-01T00:00:00.000Z',
  targetLabel: '総務部',
  purpose: '打ち合わせ',
});

const summary = (): CheckoutSelfIdSummary => ({
  checkedInAt: '2026-01-01T00:00:00.000Z',
  targetLabel: '総務部',
  purpose: '打ち合わせ',
});

describe('asPresentStayList (#1004)', () => {
  it('正しい形はそのまま通る', () => {
    expect(asPresentStayList({ stays: [stay()] })).toEqual([stay()]);
  });

  it('在館者ゼロ（空配列）は正当', () => {
    expect(asPresentStayList({ stays: [] })).toEqual([]);
  });

  it('サーバがフィールドを足しても通る（前方互換）', () => {
    expect(asPresentStayList({ stays: [{ ...stay(), addedLater: 'x' }], total: 1 })).not.toBeNull();
  });

  /**
   * 🔴 **これが本題。** `stays` キーごと欠けた 200 が `setPresent(undefined)` を呼び、
   * 次のレンダーの `present.length` で画面が落ちていた。
   */
  it('stays が無い／配列でなければ通さない（画面が落ちる形）', () => {
    expect(asPresentStayList({})).toBeNull();
    expect(asPresentStayList({ ok: true })).toBeNull();
    expect(asPresentStayList({ stays: null })).toBeNull();
    expect(asPresentStayList({ stays: 'none' })).toBeNull();
  });

  const STAY_REQUIRED: Record<RequiredKeys<PresentStaySummary>, true> = {
    stayId: true,
    checkedInAt: true,
  };

  it.each(Object.keys(STAY_REQUIRED))('在館者の必須フィールド %s が欠けていれば通さない', (key) => {
    const broken: Record<string, unknown> = { ...stay() };
    delete broken[key];
    expect(asPresentStayList({ stays: [broken] })).toBeNull();
  });

  it('🔴 要素まで見る（1 件だけ壊れた形）', () => {
    // 全要素を壊すと `every` を `some` へ替える変異が生存する。1 件だけ壊す。
    expect(asPresentStayList({ stays: [stay(), 42] })).toBeNull();
    expect(asPresentStayList({ stays: [stay(), { ...stay(), stayId: 42 }] })).toBeNull();
  });

  /**
   * 任意フィールドも「描けるか」に効く。`targetLabel` / `purpose` は一覧の各行に出る。
   */
  it('任意フィールドは省略できるが、あるなら文字列であること', () => {
    expect(asPresentStayList({ stays: [{ stayId: 's1', checkedInAt: 'x' }] })).not.toBeNull();
    expect(asPresentStayList({ stays: [{ ...stay(), targetLabel: 42 }] })).toBeNull();
    expect(asPresentStayList({ stays: [{ ...stay(), purpose: 42 }] })).toBeNull();
  });

  it('封筒がオブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asPresentStayList(notObject)).toBeNull();
    }
  });
});

describe('asCheckoutResolveResult (#1004)', () => {
  it('正しい形はそのまま通る', () => {
    expect(asCheckoutResolveResult({ method: 'qr', summary: summary() })).toEqual({
      method: 'qr',
      summary: summary(),
    });
  });

  /**
   * 🔴 **`method` は省略を許す。** 画面は `data.method ?? method`（要求した手段）で
   * フォールバックしており、**サーバが返さなくても正しく動く**。ここで必須にすると、
   * 今まで動いていた応答を弾いて**退館できなくする**（述語の偽陽性が来訪者を止める）。
   */
  it('method が無くても通る（画面側にフォールバックがある）', () => {
    expect(asCheckoutResolveResult({ summary: summary() })).toEqual({
      method: undefined,
      summary: summary(),
    });
  });

  it('method が語彙外なら通さない', () => {
    expect(asCheckoutResolveResult({ method: 'nfc', summary: summary() })).toBeNull();
  });

  /**
   * 🔴 **これが本題。** `summary` が欠けた 200 で `pending.summary.checkedInAt` が throw し、
   * **退館の確認画面**が落ちていた。
   */
  it('summary が無ければ通さない（確認画面が落ちる形）', () => {
    expect(asCheckoutResolveResult({ method: 'qr' })).toBeNull();
    expect(asCheckoutResolveResult({ ok: true })).toBeNull();
  });

  const SUMMARY_REQUIRED: Record<RequiredKeys<CheckoutSelfIdSummary>, true> = {
    checkedInAt: true,
    targetLabel: true,
    purpose: true,
  };

  /**
   * 🔴 **`targetLabel` / `purpose` は必須である。** 画面が `.trim()` を呼ぶので、
   * 欠けると確認画面で throw する（`summary` ごと欠けるのと同じ害）。
   */
  it.each(Object.keys(SUMMARY_REQUIRED))('summary の必須フィールド %s が欠けていれば通さない', (key) => {
    const broken: Record<string, unknown> = { ...summary() };
    delete broken[key];
    expect(asCheckoutResolveResult({ method: 'qr', summary: broken })).toBeNull();
  });

  it('封筒がオブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asCheckoutResolveResult(notObject)).toBeNull();
    }
  });
});
