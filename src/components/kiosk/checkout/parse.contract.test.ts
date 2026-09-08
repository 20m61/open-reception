import { describe, expect, it } from 'vitest';
import { asCheckoutResolveResult, asPresentStayList } from './parse';
import type { CheckoutSelfIdMethod } from '@/lib/visit/checkout-credential';
import type { CheckoutSelfIdSummary } from './self-id';

/**
 * **サーバが実際に返す形が、クライアントの述語を通ること** (#1004 増分 2)。
 *
 * ## なぜ要るか（独立レビュー 2 周目 MAJOR-1）
 *
 * 増分 2 は退館導線を「寛容」から「**形が違えば拒否**」へ変えた。ところが既存の検証は
 * **失敗経路しか踏んでいなかった** ―― `parse.test.ts` は壊れた入力を並べるだけ、e2e は
 * 誤ったコード・無効 token・注入した壊れた 200 だけ。つまり
 * **「正しい応答が通る」ことを誰も確かめていなかった**。
 *
 * その状態でサーバ側の応答形が 1 フィールドずれると、**QR もコードも全部弾かれて自己特定
 * 退館が全滅**し、画面は `unexpected` を出すだけで、**テストは緑のまま**である。
 * 増分の主目的（述語のせいで来訪者を止めない）のちょうど裏側が無防備だった。
 *
 * ## 何を縛るか
 *
 * 型の連結は `logic.ts` が `self-id.ts` の `CheckoutSelfIdSummary` を再輸出することで
 * `tsc` が担う（再宣言をやめた）。ここが担うのは**値の形**である ――
 * ルートが `NextResponse.json` で組み立てるオブジェクトを、そのまま述語へ食わせる。
 *
 * 🔴 **サーバ実装の写しを書かない。** ここで期待値を手で作ると「写しは必ずズレる」に戻る。
 * 組み立ての形（`{ method, summary: { checkedInAt, targetLabel, purpose } }`）は
 * `src/lib/visit/checkout-credential.ts` の `resolve()` と
 * `src/app/api/kiosk/checkout/resolve/route.ts` から取る。
 */

describe('resolve の応答契約 (#1004)', () => {
  /**
   * `CheckoutCredentialService.resolve()` の成功形をそのまま組む。
   * 型注釈をサーバ側の型で付けているので、**サーバの型が変われば tsc がここで落ちる**。
   */
  const serverSuccess = (): { method: CheckoutSelfIdMethod; summary: CheckoutSelfIdSummary } => ({
    method: 'code',
    summary: {
      checkedInAt: '2026-01-01T09:00:00.000Z',
      targetLabel: '総務部',
      purpose: '打ち合わせ',
    },
  });

  it('サーバの成功応答は述語を通る（QR / コード両方）', () => {
    for (const method of ['qr', 'code'] as const) {
      const parsed = asCheckoutResolveResult({ ...serverSuccess(), method });
      expect(parsed).not.toBeNull();
      expect(parsed?.method).toBe(method);
      expect(parsed?.summary).toEqual(serverSuccess().summary);
    }
  });

  /**
   * サーバは `CheckoutCredential` の値をそのまま写す。`targetLabel` / `purpose` は
   * `issue` 時に `?? ''` されるので**空文字で来ることがある** ―― これを弾くと、
   * 呼び出し先ラベルが未設定の来訪者だけ退館できなくなる。
   */
  it('空文字のラベル・用件でも通る（issue 側が `?? ""` で埋める）', () => {
    const parsed = asCheckoutResolveResult({
      method: 'qr',
      summary: { checkedInAt: '2026-01-01T09:00:00.000Z', targetLabel: '', purpose: '' },
    });
    expect(parsed).not.toBeNull();
  });
});

/**
 * 在館一覧 `GET /api/kiosk/checkout` の応答契約。
 *
 * ルートの `PresentStaySummary`（`src/app/api/kiosk/checkout/route.ts`）は
 * `targetLabel` / `purpose` を**任意**として宣言している。`NextResponse.json` は
 * `undefined` のキーを落とすので、実際の応答は「キーごと無い」形で届く。
 */
describe('在館一覧の応答契約 (#1004)', () => {
  it('任意フィールドが落ちた応答でも通る（NextResponse.json は undefined を落とす）', () => {
    const wire = JSON.parse(
      JSON.stringify({
        stays: [
          { stayId: 's1', checkedInAt: '2026-01-01T09:00:00.000Z', targetLabel: undefined, purpose: undefined },
          { stayId: 's2', checkedInAt: '2026-01-01T10:00:00.000Z', targetLabel: '総務部', purpose: '打ち合わせ' },
        ],
      }),
    ) as unknown;
    const parsed = asPresentStayList(wire);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
  });

  it('在館者ゼロの応答が通る（受付直後の通常状態）', () => {
    expect(asPresentStayList(JSON.parse(JSON.stringify({ stays: [] })) as unknown)).toEqual([]);
  });
});
