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
