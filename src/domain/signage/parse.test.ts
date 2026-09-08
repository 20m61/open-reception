import { describe, expect, it } from 'vitest';
import { asSignageConfig } from './parse';
import { asSignageItemId, type SignageConfig } from './types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

/**
 * サイネージ設定の応答が**確かめられた形か** (#1004)。
 *
 * 由来: `setConfig((await res.json()) as SignageConfig)` で通していたため、企業プロキシ・
 * API のバージョンスキュー・途中で切れた本文が返す `200 {"ok":true}` がそのまま state に入り、
 * **次のレンダーで `config.items.map` が TypeError → `/admin/signage` が画面ごと落ちる**
 * （`src/app/admin` 配下に error boundary は無い）。#973 増分 02 が `SecurityManager` へ入れた
 * 「**確かめられた 200 だけを成功と呼ぶ**」を、この画面へ広げる。
 *
 * 🔴 **必須フィールドの網羅は型から強制する。** 手で列挙すると、型にフィールドが増えたとき
 * テストが追随せず**述語の穴が見えないまま**残る（このリポジトリが繰り返している
 * 「写しは必ずズレる」型）。`Record<RequiredKeys<T>, true>` にしておくと、必須フィールドを
 * 足した瞬間に**この行が型エラーになる**ので、追随を忘れられない。
 */

/** `T` の必須キー（任意プロパティを除く）。 */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

const valid = (): SignageConfig => ({
  tenantId: asTenantId('internal'),
  siteId: asSiteId('default-site'),
  enabled: true,
  defaultIntervalSeconds: 10,
  items: [{ id: asSignageItemId('a'), type: 'clock', enabled: true }],
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('asSignageConfig (#1004)', () => {
  it('正しい形はそのまま通る', () => {
    expect(asSignageConfig(valid())).toEqual(valid());
  });

  it('サーバがフィールドを足しても通る（前方互換）', () => {
    expect(asSignageConfig({ ...valid(), addedLater: 'x' })).not.toBeNull();
  });

  // 🔴 型から網羅を強制する。必須フィールドが増えたらこの Record が型エラーになる。
  const REQUIRED: Record<RequiredKeys<SignageConfig>, true> = {
    tenantId: true,
    siteId: true,
    enabled: true,
    defaultIntervalSeconds: true,
    items: true,
    updatedAt: true,
  };

  it.each(Object.keys(REQUIRED))('必須フィールド %s が欠けていれば通さない', (key) => {
    const broken: Record<string, unknown> = { ...valid() };
    delete broken[key];
    expect(asSignageConfig(broken)).toBeNull();
  });

  it('items が配列でなければ通さない（`items.map` が落ちる形）', () => {
    expect(asSignageConfig({ ...valid(), items: 'x' })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: null })).toBeNull();
  });

  it('🔴 items の要素まで見る（1 要素だけ壊れた形）', () => {
    // 全要素が壊れていると `some` を `every` へ替える変異が生存する（#973 で実測した型）。
    expect(asSignageConfig({ ...valid(), items: [{ id: 'a', type: 'clock', enabled: true }, 42] })).toBeNull();
  });

  /**
   * 🔴 **任意フィールドも「描けるか」に効く。** `slideUrls` が配列でないと
   * `(item.slideUrls ?? []).join('\n')` が throw する。
   */
  it('🔴 項目の任意フィールドが壊れていれば通さない', () => {
    const base = { id: 'a', type: 'slides', enabled: true };
    expect(asSignageConfig({ ...valid(), items: [{ ...base, slideUrls: 'x' }] })).toBeNull();
    // 1 要素だけ壊れた形（全部壊すと `every`→`some` の変異が生存する）。
    expect(asSignageConfig({ ...valid(), items: [{ ...base, slideUrls: ['u', 7] }] })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: [{ ...base, durationSeconds: '10' }] })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: [{ ...base, message: 42 }] })).toBeNull();
    /*
      🔴 **同じヘルパを使う行は、行ごとに縛る**（独立レビュー 2 周目 MINOR-2）。`message` だけを
      置いていたので、`title` / `imageUrl` / `imageAlt` の `isOptionalString` 行を**個別に**消す
      変異が 3 種とも生存した。ヘルパが共通でも、呼び出し行は別々に落とせる。
    */
    expect(asSignageConfig({ ...valid(), items: [{ ...base, title: 42 }] })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: [{ ...base, imageUrl: 42 }] })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: [{ ...base, imageAlt: 42 }] })).toBeNull();
  });

  /**
   * `enabled` は checkbox の `checked` に載る。文字列が入っても throw しないが、React が
   * controlled/uncontrolled の警告を出し、**運用者が触るまで表示と実体がずれる**。
   */
  it('項目の enabled が真偽値でなければ通さない', () => {
    expect(asSignageConfig({ ...valid(), items: [{ id: 'a', type: 'clock', enabled: 'true' }] })).toBeNull();
    expect(asSignageConfig({ ...valid(), items: [{ id: 'a', type: 'clock' }] })).toBeNull();
  });

  it('任意フィールドが無い項目は正当', () => {
    expect(asSignageConfig({ ...valid(), items: [{ id: 'a', type: 'slides', enabled: true }] })).not.toBeNull();
  });

  it('項目の type が語彙外なら通さない', () => {
    expect(
      asSignageConfig({ ...valid(), items: [{ id: 'a', type: 'marquee', enabled: true }] }),
    ).toBeNull();
  });

  it('オブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asSignageConfig(notObject)).toBeNull();
    }
  });
});
