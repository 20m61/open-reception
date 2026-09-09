import { describe, expect, it } from 'vitest';
import { asCheckoutFailureReason, asCheckoutResolveResult, asPresentStayList } from './parse';
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

  /**
   * 🔴 **JSON の `null` を「無い」と同じに扱う**（独立レビュー 1 周目 MINOR-3）。
   * 今のサーバは `NextResponse.json` が `undefined` キーを落とすので `null` は来ないが、
   * serializer が変わった瞬間に**在館一覧が丸ごと消える** ―― QR もコードも失くした
   * 来訪者の最後の手段である。画面側は `?? ''` で受けているので通しても壊れない。
   */
  it('任意フィールドの null は「無い」として通し、キーごと落として返す', () => {
    // 🔴 型述語ではなく**正規化**して返す（独立レビュー 2 周目 MINOR-2）。`null` を通すのに
    // `targetLabel?: string` と宣言していると型が嘘をつき、`=== undefined` で分岐する
    // 読み手が現れた瞬間に `null.trim()` になる。
    expect(asPresentStayList({ stays: [{ ...stay(), targetLabel: null, purpose: null }] })).toEqual([
      { stayId: 's1', checkedInAt: '2026-01-01T00:00:00.000Z' },
    ]);
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

  /**
   * 🔴 **未知の `method` で応答ごと捨てない**（独立レビュー 1 周目 MAJOR-1）。
   * `pending.method` は**書かれるだけで一度も読まれない**。当初は語彙外を null にして
   * いたが、それは**消費者ゼロのフィールドで退館導線を止める**設計で、サーバが手段を
   * 1 つ増やした瞬間に QR もコードも全部弾かれる。未知値は無視して先へ通す。
   */
  it('method が語彙外でも応答は通す（未知値は無視する）', () => {
    expect(asCheckoutResolveResult({ method: 'nfc', summary: summary() })).toEqual({
      method: undefined,
      summary: summary(),
    });
    expect(asCheckoutResolveResult({ method: 42, summary: summary() })).toEqual({
      method: undefined,
      summary: summary(),
    });
  });

  /**
   * 🔴 **これが本題。** `summary` が欠けた 200 で `pending.summary.checkedInAt` が throw し、
   * **退館の確認画面**が落ちていた。
   */
  it('summary が無ければ通さない（確認画面が落ちる形）', () => {
    expect(asCheckoutResolveResult({ method: 'qr' })).toBeNull();
    expect(asCheckoutResolveResult({ ok: true })).toBeNull();
  });

  it('summary の checkedInAt が無ければ通さない（確認画面の判別材料）', () => {
    expect(asCheckoutResolveResult({ method: 'qr', summary: { targetLabel: 'a', purpose: 'b' } })).toBeNull();
    expect(
      asCheckoutResolveResult({ method: 'qr', summary: { ...summary(), checkedInAt: 42 } }),
    ).toBeNull();
  });

  /**
   * 🔴 **表示専用のフィールドで退館を止めない**（独立レビュー 1 周目 MINOR-4）。
   * `targetLabel` / `purpose` は確認画面に出るだけで、画面側に既定値（「（不明）」）がある。
   * 本人性は token またはコード＋ラベル一致で既に立っているので、ラベルが欠けたことを
   * 理由に導線を止める理由が無い（`docs/experience/README.md` 原則 5）。空文字へ寄せる。
   */
  it('summary の表示専用フィールドは欠けても通し、空文字へ寄せる', () => {
    expect(asCheckoutResolveResult({ summary: { checkedInAt: 'x' } })).toEqual({
      method: undefined,
      summary: { checkedInAt: 'x', targetLabel: '', purpose: '' },
    });
    expect(asCheckoutResolveResult({ summary: { checkedInAt: 'x', targetLabel: null, purpose: null } })).toEqual({
      method: undefined,
      summary: { checkedInAt: 'x', targetLabel: '', purpose: '' },
    });
    // 型が違うもの（数値など）は通さない ―― `.trim()` が throw する。
    expect(asCheckoutResolveResult({ summary: { checkedInAt: 'x', targetLabel: 42 } })).toBeNull();
  });

  it('封筒がオブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asCheckoutResolveResult(notObject)).toBeNull();
    }
  });
});

describe('asCheckoutFailureReason (#1004 増分 2・6 周目 MINOR-5)', () => {
  it('文字列の理由はそのまま使う', () => {
    expect(asCheckoutFailureReason({ error: 'expired' })).toBe('expired');
  });

  /*
    🔴 **これが本題**。`data?.error ?? 'network'` は `??` なので falsy な `0` を素通しし、
    画面側の `errorReason ? MESSAGE : null` が握り潰す ―― 来訪者は押した結果を
    **何も見ない**まま入力画面に留まる。理由が読めないなら読めないなりに何か出す。
  */
  it('falsy だが null/undefined ではない値を素通ししない', () => {
    for (const falsy of [0, '', false, Number.NaN]) {
      expect(asCheckoutFailureReason({ error: falsy })).toBe('network');
    }
  });

  it('文字列でない理由は使わない', () => {
    for (const notString of [42, {}, [], true, { message: 'x' }]) {
      expect(asCheckoutFailureReason({ error: notString })).toBe('network');
    }
  });

  it('空白のみの理由も使わない（画面で消えるため）', () => {
    expect(asCheckoutFailureReason({ error: '   ' })).toBe('network');
  });

  // 現行の挙動（`{}` は `network`）は変えない ―― この述語が直すのは「何も出ない」だけ。
  it('理由が無い応答・読めなかった応答は network のまま', () => {
    for (const empty of [{}, null, undefined, 'x', 3, []]) {
      expect(asCheckoutFailureReason(empty)).toBe('network');
    }
  });
});
