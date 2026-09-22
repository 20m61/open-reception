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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
   * 🔴 **窓のレコードは自然消滅する（変異 M17 が生存した穴）。**
   *
   * 掃除を運用に頼らない（溜まると DynamoDB のコストと、窓が古いまま残る面を作る）。
   * 以前はレコードの**存在だけ**を見ていたので、`ttlSeconds` を外す変異が素通りした ——
   * 「TTL 付きに置く」と doc に書きながら、**TTL を主張していなかった**。
   * memory backend は `ttlSeconds` を無視するので、**渡していること**を見る。
   */
  it('🔴 窓は TTL 付きのコレクションに置く', async () => {
    const backend = getBackend();
    const spy = vi.spyOn(backend, 'collection');
    await recordFailure(KEY, POLICY, 1000);
    const call = spy.mock.calls.find((c) => c[0] === 'auth-attempts');
    expect(call, 'auth-attempts コレクションを開いていない').toBeDefined();
    const ttl = (call?.[1] as { ttlSeconds?: number } | undefined)?.ttlSeconds;
    expect(ttl, 'ttlSeconds を渡していない（窓のレコードが溜まり続ける）').toBeGreaterThan(0);
    // 下界: 窓より十分長い（窓が明ける前に消えると予算が実質的に増える）。
    expect(ttl).toBeGreaterThan(POLICY.windowMs / 1000);
    spy.mockRestore();
  });

  /**
   * 🔴 **本体（変異 M18 が生存した穴。重大）。**
   *
   * `recordFailure` の窓明け判定を外すと、`startedAt` が**最初の失敗の時刻のまま
   * 二度と動かない**。すると `checkAttempt` は常に「窓が明けている」と判定するので、
   * **最初の窓が過ぎた時点で試行回数制限が恒久的に無効化される**（数え続けるが誰も断らない）。
   *
   * 症状は「制限が効かない」だけなので、**緑のまま気づけない**型である。
   */
  it('🔴 窓が明けた後の失敗は新しい窓を開く（制限が無効化されない）', async () => {
    const t0 = 1000;
    const t1 = t0 + POLICY.windowMs; // 窓明け後
    await recordFailure(KEY, POLICY, t0);
    // 窓明け後に予算ぶん失敗させる。
    for (let i = 0; i < POLICY.budget; i += 1) await recordFailure(KEY, POLICY, t1);
    // 🔴 新しい窓で数えていれば、この時点で断られる。
    //    古い窓に足し続けていると `startedAt` が t0 のままなので**常に許可**になる。
    const r = await checkAttempt(KEY, POLICY, t1);
    expect(r.allowed, '窓明け後の失敗が古い窓に足されている（制限が無効化されている）').toBe(
      false,
    );
  });

  /**
   * 🔴 **壊れたレコードで 500 にしない（変異 M15 が生存した穴）。**
   *
   * この経路は**未認証で叩ける**ので、レコードが 1 件壊れているだけで
   * **全端末の authorize が落ちる**（復旧導線ごと失われる）。読めないものは
   * 「窓が無い」＝許可側へ倒し、予算は次の失敗から数え直す。
   */
  it.each([
    ['startedAt が文字列', { id: KEY, startedAt: 'x', failures: 1 }],
    ['failures が欠落', { id: KEY, startedAt: 1000 }],
    ['NaN', { id: KEY, startedAt: Number.NaN, failures: Number.NaN }],
  ])('🔴 壊れたレコード（%s）で落ちない', async (_label, broken) => {
    await getBackend()
      .collection<{ id: string }>('auth-attempts', { ttlSeconds: 7200 })
      .put(broken as { id: string });
    const r = await checkAttempt(KEY, POLICY, 2000);
    expect(r.allowed).toBe(true);
    // 下界: 壊れたレコードを「予算を使い切った」と読んで締め出してもいない。
    await expect(recordFailure(KEY, POLICY, 2000)).resolves.toBeUndefined();
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
