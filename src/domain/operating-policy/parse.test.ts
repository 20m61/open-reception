import { describe, expect, it } from 'vitest';
import {
  asOperatingPolicyResponse,
  asSavedOperatingPolicyResponse,
  asServiceOperatingPolicy,
} from './parse';
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

  /**
   * 🔴 **値まで見る。** キーの存在だけ見て通すと配列でない値が素通りし、
   * `formatTimeRanges` の `ranges.map` が throw → `void load()` が未処理 rejection になり、
   * 画面が「読み込み中…」で止まる（**その枝には再試行ボタンが無い**）。
   */
  it('🔴 weeklySchedule の値が時間帯の配列でなければ通さない（1 曜日だけ壊れた形）', () => {
    // 全曜日を壊すと `every` を `some` へ替える変異が生存する。1 つだけ壊す。
    expect(
      asServiceOperatingPolicy({
        ...valid(),
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }], tue: 'x' },
      }),
    ).toBeNull();
    expect(
      asServiceOperatingPolicy({
        ...valid(),
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }], tue: { start: '09:00', end: '18:00' } },
      }),
    ).toBeNull();
    expect(
      asServiceOperatingPolicy({
        ...valid(),
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }, { start: 9 }] },
      }),
    ).toBeNull();
  });

  /**
   * 🔴 **`exceptionDates[i].ranges` にも同じ hazard がある**（独立レビュー 2 周目 MINOR-1）。
   * 実装は見ているのに、テストが `weeklySchedule` 側にしか無かった —— 変異行列で
   * 「`ranges` の検査を丸ごと削除」「`.every(isTimeRange)` だけ削除」「`Array.isArray` だけ削除」
   * の 3 種がすべて生存した。害は上と同一で、`formatExceptionsText` → `formatTimeRanges` の
   * `.map` が throw し、画面が「読み込み中…」で止まる。
   */
  it('🔴 exceptionDates の ranges が時間帯の配列でなければ通さない（1 件だけ壊れた形）', () => {
    const ok = { date: '2026-05-03', closed: true };
    // 1 件だけ壊す（全部壊すと `every` → `some` の変異が生存する）。
    expect(
      asServiceOperatingPolicy({ ...valid(), exceptionDates: [ok, { date: '2026-05-04', closed: false, ranges: 'x' }] }),
    ).toBeNull();
    expect(
      asServiceOperatingPolicy({
        ...valid(),
        exceptionDates: [ok, { date: '2026-05-04', closed: false, ranges: { start: '10:00', end: '12:00' } }],
      }),
    ).toBeNull();
    expect(
      asServiceOperatingPolicy({
        ...valid(),
        exceptionDates: [
          ok,
          { date: '2026-05-04', closed: false, ranges: [{ start: '10:00', end: '12:00' }, { start: 10 }] },
        ],
      }),
    ).toBeNull();
  });

  it('exceptionDates の ranges 省略（終日休業）は正当', () => {
    expect(
      asServiceOperatingPolicy({ ...valid(), exceptionDates: [{ date: '2026-05-03', closed: true }] }),
    ).not.toBeNull();
  });

  /**
   * 時間帯の `end` と例外日の `closed` は throw させないが、**表示が化けたまま再保存され得る**
   * （`"09:00-undefined"`、チェックボックスに文字列）。独立レビュー 2 周目 MINOR-2 の生存変異。
   */
  it('TimeRange の start / end はどちらも文字列であること', () => {
    for (const bad of [{ start: '09:00' }, { end: '18:00' }, { start: '09:00', end: 18 }]) {
      expect(asServiceOperatingPolicy({ ...valid(), weeklySchedule: { mon: [bad] } })).toBeNull();
    }
  });

  it('例外日の closed が真偽値でなければ通さない', () => {
    expect(
      asServiceOperatingPolicy({ ...valid(), exceptionDates: [{ date: '2026-05-03', closed: 'true' }] }),
    ).toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), exceptionDates: [{ date: '2026-05-03' }] })).toBeNull();
  });

  /**
   * 🔴 **画面が `.trim()` を呼ぶ任意フィールド**（独立レビュー 2 周目 MINOR-3）。非文字列が
   * 入ると保存の `try` の中で throw し、`catch` が「サーバーに接続できませんでした」という
   * **まったく無関係な文言**を出す。
   */
  it('emergencyContactLabel は省略できるが、あるなら文字列であること', () => {
    expect(asServiceOperatingPolicy({ ...valid(), emergencyContactLabel: '内線 100' })).not.toBeNull();
    expect(asServiceOperatingPolicy(valid())).not.toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), emergencyContactLabel: 42 })).toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), emergencyContactLabel: null })).toBeNull();
  });

  it('weeklySchedule が空（全曜日休業）は正当', () => {
    expect(asServiceOperatingPolicy({ ...valid(), weeklySchedule: {} })).not.toBeNull();
    expect(asServiceOperatingPolicy({ ...valid(), weeklySchedule: { mon: [] } })).not.toBeNull();
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

describe('asSavedOperatingPolicyResponse (#1004)', () => {
  it('保存の応答に policy が入っていれば返す', () => {
    const policy = valid();
    expect(asSavedOperatingPolicyResponse({ policy })).toEqual(policy);
  });

  /**
   * 🔴 **これが本題。** GET では `policy: null` が正当だが、**PUT の応答に null はあり得ない**。
   * 通すと画面が「まだ設定がありません」へ化けたうえで「保存しました」を出し、次の保存で
   * `expectedVersion` が落ちてサーバが 409 → 画面は「ほかの管理者が更新済み」という嘘を出す。
   */
  it('policy: null は保存の応答としては通さない', () => {
    expect(asSavedOperatingPolicyResponse({ policy: null })).toBeNull();
  });

  it('形が違えば通さない', () => {
    expect(asSavedOperatingPolicyResponse({ ok: true })).toBeNull();
    expect(asSavedOperatingPolicyResponse({ policy: { ...valid(), version: '3' } })).toBeNull();
  });
});
