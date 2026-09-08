import { describe, expect, it } from 'vitest';
import { asOperatingPolicyResponse, asServiceOperatingPolicy } from './parse';
import type { ServiceOperatingPolicy } from './types';

/**
 * 営業時間ポリシーの応答が**確かめられた形か** (#1004)。
 *
 * 由来: `(await res.json()) as { policy: PolicyView }` で通していたため、`policy` が
 * 欠けた 200 でも `applyPolicy(undefined)` が走り、**フォームが黙って既定値へ初期化される**。
 * さらに `setPolicy(undefined)` で以後の保存から `expectedVersion` が落ちる ――
 * **#367 の楽観ロック（同時編集の後勝ち検出）が外れる**。そのうえで「保存しました」と出る。
 *
 * 🔴 **必須フィールドの網羅は型から強制する**（`Record<RequiredKeys<T>, true>`）。
 * 手で列挙すると、型にフィールドが増えたときテストが追随せず述語の穴が残る。
 */

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

const valid = (): ServiceOperatingPolicy => ({
  tenantId: 'internal',
  siteId: 'default-site',
  timezone: 'Asia/Tokyo',
  weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
  fixedHolidays: ['01-01'],
  exceptionDates: [{ date: '2026-05-03', closed: true }],
  version: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'admin',
});

describe('asServiceOperatingPolicy (#1004)', () => {
  it('正しい形はそのまま通る', () => {
    expect(asServiceOperatingPolicy(valid())).toEqual(valid());
  });

  it('サーバがフィールドを足しても通る（前方互換）', () => {
    expect(asServiceOperatingPolicy({ ...valid(), addedLater: 'x' })).not.toBeNull();
  });

  const REQUIRED: Record<RequiredKeys<ServiceOperatingPolicy>, true> = {
    tenantId: true,
    siteId: true,
    timezone: true,
    weeklySchedule: true,
    fixedHolidays: true,
    exceptionDates: true,
    version: true,
    updatedAt: true,
    updatedBy: true,
  };

  it.each(Object.keys(REQUIRED))('必須フィールド %s が欠けていれば通さない', (key) => {
    const broken: Record<string, unknown> = { ...valid() };
    delete broken[key];
    expect(asServiceOperatingPolicy(broken)).toBeNull();
  });

  /**
   * 🔴 **`version` は楽観ロックの要**。数値でない値を通すと `expectedVersion` に載り、
   * サーバ側の後勝ち検出が壊れる（#367）。ここは型を見るだけでは足りない箇所である。
   */
  it('version が数値でなければ通さない', () => {
    expect(asServiceOperatingPolicy({ ...valid(), version: '3' })).toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), version: null })).toBeNull();
  });

  it('配列であるべきものが配列でなければ通さない', () => {
    expect(asServiceOperatingPolicy({ ...valid(), fixedHolidays: '01-01' })).toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), exceptionDates: {} })).toBeNull();
  });

  it('🔴 配列の要素まで見る（1 要素だけ壊れた形）', () => {
    expect(asServiceOperatingPolicy({ ...valid(), fixedHolidays: ['01-01', 7] })).toBeNull();
    expect(
      asServiceOperatingPolicy({ ...valid(), exceptionDates: [{ date: '2026-05-03', closed: true }, 42] }),
    ).toBeNull();
  });

  it('weeklySchedule がオブジェクトでなければ通さない', () => {
    expect(asServiceOperatingPolicy({ ...valid(), weeklySchedule: [] })).toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), weeklySchedule: 'mon' })).toBeNull();
  });

  it('オブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asServiceOperatingPolicy(notObject)).toBeNull();
    }
  });
});

describe('asOperatingPolicyResponse (#1004)', () => {
  it('policy: null は正当（そのサイトはまだ未設定）', () => {
    expect(asOperatingPolicyResponse({ policy: null })).toEqual({ policy: null });
  });

  it('policy が入っていればそのまま通る', () => {
    const policy = valid();
    expect(asOperatingPolicyResponse({ policy })).toEqual({ policy });
  });

  /**
   * 🔴 **これが本題。** `policy` キーごと欠けた 200 が `applyPolicy(undefined)` を呼び、
   * フォームを黙って初期化して `expectedVersion` を落としていた（#367 の楽観ロックが外れる）。
   * `policy: null`（未設定）と混同しない。
   */
  it('policy キーが無ければ通さない（未設定と混同しない）', () => {
    expect(asOperatingPolicyResponse({})).toBeNull();
    expect(asOperatingPolicyResponse({ ok: true })).toBeNull();
    expect(asOperatingPolicyResponse({ policy: undefined })).toBeNull();
  });

  it('policy の形が違えば通さない', () => {
    expect(asOperatingPolicyResponse({ policy: { ok: true } })).toBeNull();
    expect(asOperatingPolicyResponse({ policy: { ...valid(), version: '3' } })).toBeNull();
  });

  it('封筒がオブジェクトでなければ通さない', () => {
    for (const notObject of [null, undefined, 'x', 3, true, []]) {
      expect(asOperatingPolicyResponse(notObject)).toBeNull();
    }
  });
});
