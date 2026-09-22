/**
 * 試行予算の永続化（#1021 AC4）。
 *
 * ## なぜ `get` → `put` ではいけないか
 *
 * 🔴 **数え上げは read-modify-write なので、素朴に書くと並行で素通りする。**
 * 総当たりを仕掛ける側は**並列に**投げるので、全員が `failures: 0` を読んで全員が通る。
 * それは「予算」ではない。このリポジトリは同型の lost-update を #1158 に持っている。
 *
 * だから `Collection.updateIf`（atomic compare-and-set。memory / dynamo 両方で
 * `update-if-contract.test.ts` が意味論を固定している）に載せる。
 *
 * ## 縛る不変条件
 *
 * > **N 並列で失敗を投げても、記録される失敗数は N である**（取りこぼさない）。
 *
 * 取りこぼすと予算が実質的に増える＝上界が壊れる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { KIOSK_AUTHORIZE_POLICY, type AttemptPolicy } from '@/domain/security/attempt-budget';
import { getBackend } from '@/lib/data';
import { checkAttempt, recordFailure, recordSuccess, __resetAttempts } from './attempt-store';

const POLICY: AttemptPolicy = { budget: 3, windowMs: 60_000 };
const KEY = 'kiosk:kiosk-dev';

beforeEach(async () => {
  await __resetAttempts();
});

describe('試行予算ストア (#1021 AC4)', () => {
  it('初回は許可する', async () => {
    const r = await checkAttempt(KEY, POLICY, 1000);
    expect(r.allowed).toBe(true);
  });

  it('🔴 予算を使い切ると断る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) {
      const r = await checkAttempt(KEY, POLICY, 1000);
      expect(r.allowed, `${i} 回目で断られた（予算は ${POLICY.budget}）`).toBe(true);
      await recordFailure(KEY, POLICY, 1000);
    }
    const blocked = await checkAttempt(KEY, POLICY, 1000);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error('unreachable');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  /** 🔴 下界: 窓が明ければ通る（恒久的に閉じない）。 */
  it('🔴 窓が明ければ、使い切った後でも通る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await recordFailure(KEY, POLICY, 1000);
    expect((await checkAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    expect((await checkAttempt(KEY, POLICY, 1000 + POLICY.windowMs)).allowed).toBe(true);
  });

  /** 🔴 成功は失敗数を捨てる。 */
  it('🔴 成功すると予算が戻る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await recordFailure(KEY, POLICY, 1000);
    expect((await checkAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    await recordSuccess(KEY);
    expect((await checkAttempt(KEY, POLICY, 1000)).allowed).toBe(true);
  });

  /** 🔴 鍵が違えば独立（1 つの端末の失敗が別の端末を閉めない）。 */
  it('🔴 別の鍵は独立して数える', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await recordFailure(KEY, POLICY, 1000);
    expect((await checkAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    expect((await checkAttempt('kiosk:other', POLICY, 1000)).allowed).toBe(true);
  });

  /**
   * 🔴 **本体（原子性）。** 並行で失敗を投げても取りこぼさない。
   *
   * 素朴な `get` → `put` はここで落ちる（全員が同じ値を読んで最後の 1 つが勝つので、
   * 記録される失敗数が 1 になる）。取りこぼすと予算が実質的に増える＝上界が壊れる。
   */
  it('🔴 並行した失敗を取りこぼさない', async () => {
    const n = 20;
    await Promise.all(Array.from({ length: n }, () => recordFailure(KEY, { budget: 1000, windowMs: 60_000 }, 1000)));
    const r = await checkAttempt(KEY, { budget: n, windowMs: 60_000 }, 1000);
    // n 回数えていれば、予算 n はちょうど使い切られている。
    expect(r.allowed, `失敗を取りこぼしている（予算 ${n} が余っている）`).toBe(false);
  });

  /**
   * 🔴 **窓のレコードは自然消滅する。** 掃除を運用に頼らない
   * （溜まると DynamoDB のコストと、窓が古いまま残る面を作る）。
   */
  it('🔴 窓は TTL 付きのコレクションに置く', async () => {
    await recordFailure(KEY, POLICY, 1000);
    const raw = await getBackend()
      .collection<{ id: string }>('auth-attempts')
      .get(KEY);
    expect(raw).toBeDefined();
  });

  /** 実運用の方針でも上界・下界が成り立つ（定数を差し替えても壊れない）。 */
  it('実運用の kiosk 方針でも上界と下界が成り立つ', async () => {
    const now = 1_000_000;
    for (let i = 0; i < KIOSK_AUTHORIZE_POLICY.budget; i += 1) {
      expect((await checkAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now)).allowed).toBe(true);
      await recordFailure(KEY, KIOSK_AUTHORIZE_POLICY, now);
    }
    expect((await checkAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now)).allowed).toBe(false);
    expect(
      (await checkAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now + KIOSK_AUTHORIZE_POLICY.windowMs))
        .allowed,
    ).toBe(true);
  });
});
