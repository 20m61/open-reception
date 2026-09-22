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
import {
  recordLayeredSuccess,
  recordSuccess,
  reserveAttempt,
  reserveLayered,
  __resetAttempts,
} from './attempt-store';
import { GLOBAL_IDENTITY } from './client-identity';

const POLICY: AttemptPolicy = { budget: 3, windowMs: 60_000 };
const KEY = 'kiosk:kiosk-dev';

beforeEach(async () => {
  await __resetAttempts();
});

describe('試行予算ストア (#1021 AC4)', () => {
  it('初回は許可する', async () => {
    const r = await reserveAttempt(KEY, POLICY, 1000);
    expect(r.allowed).toBe(true);
  });

  it('🔴 予算を使い切ると断る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) {
      const r = await reserveAttempt(KEY, POLICY, 1000);
      expect(r.allowed, `${i} 回目で断られた（予算は ${POLICY.budget}）`).toBe(true);
    }
    const blocked = await reserveAttempt(KEY, POLICY, 1000);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error('unreachable');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  /** 🔴 下界: 窓が明ければ通る（恒久的に閉じない）。 */
  it('🔴 窓が明ければ、使い切った後でも通る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await reserveAttempt(KEY, POLICY, 1000);
    expect((await reserveAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    expect((await reserveAttempt(KEY, POLICY, 1000 + POLICY.windowMs)).allowed).toBe(true);
  });

  /** 🔴 成功は失敗数を捨てる。 */
  it('🔴 成功すると予算が戻る', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await reserveAttempt(KEY, POLICY, 1000);
    expect((await reserveAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    await recordSuccess(KEY);
    expect((await reserveAttempt(KEY, POLICY, 1000)).allowed).toBe(true);
  });

  /** 🔴 鍵が違えば独立（1 つの端末の失敗が別の端末を閉めない）。 */
  it('🔴 別の鍵は独立して数える', async () => {
    for (let i = 0; i < POLICY.budget; i += 1) await reserveAttempt(KEY, POLICY, 1000);
    expect((await reserveAttempt(KEY, POLICY, 1000)).allowed).toBe(false);
    expect((await reserveAttempt('kiosk:other', POLICY, 1000)).allowed).toBe(true);
  });

  /**
   * 🔴 **本体（原子性）。並行して投げても、照合が走る回数が予算を超えない。**
   *
   * ## 最初はこの不変条件を測っていなかった（Codex レビュー P1）
   *
   * 以前ここは「並行した `recordFailure` が取りこぼさない」だけを主張していた。
   * **数え上げが原子的であることは、入場が原子的であることを何も意味しない** ——
   * 読み取り専用の `checkAttempt` で入場を判定していたので、並行バーストでは
   * **全員が予算内と読んで全員が照合へ進んだ**（実測: 予算 3 に対して 20 回中 20 回が
   * 照合まで到達し、**0 回しか断られなかった**）。
   *
   * つまり総当たりは**並列に投げるだけで素通り**でき、PBKDF2 の計算増幅も閉じていなかった。
   * 自分が作った機構（CAS の数え上げ）をテストしていて、**守るべき不変条件**を
   * テストしていなかった型である。
   *
   * だから入場そのものを原子的にする（`reserveAttempt`）。
   */
  it('🔴 並行バーストでも照合の回数は予算を超えない', async () => {
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, () => reserveAttempt(KEY, POLICY, 1000)),
    );
    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted, `予算 ${POLICY.budget} に対して ${admitted} 回入場した`).toBe(POLICY.budget);
    // 下界: 全部断ってもいない（それでは受付が止まる）。
    expect(admitted).toBeGreaterThan(0);
  });

  /** 🔴 逐次でも予算ぶんはちょうど入場できる（上界だけでなく下界も）。 */
  it('🔴 逐次なら予算ぶんちょうど入場できる', async () => {
    let admitted = 0;
    for (let i = 0; i < POLICY.budget + 5; i += 1) {
      if ((await reserveAttempt(KEY, POLICY, 1000)).allowed) admitted += 1;
    }
    expect(admitted).toBe(POLICY.budget);
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
    await reserveAttempt(KEY, POLICY, 1000);
    const call = spy.mock.calls.find((c) => c[0] === 'auth-attempts');
    expect(call, 'auth-attempts コレクションを開いていない').toBeDefined();
    const ttl = (call?.[1] as { ttlSeconds?: number } | undefined)?.ttlSeconds;
    expect(ttl, 'ttlSeconds を渡していない（窓のレコードが溜まり続ける）').toBeGreaterThan(0);
    // 下界: 窓より十分長い（窓が明ける前に消えると予算が実質的に増える）。
    expect(ttl).toBeGreaterThan(POLICY.windowMs / 1000);
    spy.mockRestore();
  });

  /**
   * 🔴 **窓を開き直すときは TTL も延ばす（Codex レビュー P2）。**
   *
   * backend は `put` / `putIfAbsent` のときだけ `ttlSeconds` から `ttl` を生成する
   * （`recordFor`）。`updateIf` は**部分マージ**なので `ttl` に触らない —— 同じレコードを
   * 新しい窓へ転がし続けると**最初に作ったときの期限のまま**になり、稼働中のカウンタが
   * 2 時間後に消えて**攻撃者の予算が戻る**。
   *
   * memory backend は `ttl` を解釈しないので、**レコードに載っていること**を見る。
   */
  it('🔴 窓を開き直すと TTL が延びる', async () => {
    const raw = () =>
      getBackend()
        .collection<{ id: string; ttl?: number }>('auth-attempts', { ttlSeconds: 7200 })
        .get(KEY);
    await reserveAttempt(KEY, POLICY, 1000);
    // 窓明け後に予約すると、同じレコードが新しい窓へ転がる（`updateIf` の経路）。
    const later = 1000 + POLICY.windowMs * 3;
    await reserveAttempt(KEY, POLICY, later);
    const after = await raw();
    expect(after?.ttl, 'TTL が載っていない（窓を転がすと期限が延びない）').toBeDefined();
    // 下界: 延ばした先が「今」より十分に後ろ（0 や過去を書いていない）。
    expect(after?.ttl).toBeGreaterThan(Math.floor(later / 1000));
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
    await reserveAttempt(KEY, POLICY, t0);
    // 窓明け後に予算ぶん試行させる。
    for (let i = 0; i < POLICY.budget; i += 1) await reserveAttempt(KEY, POLICY, t1);
    // 🔴 新しい窓で数えていれば、この時点で断られる。
    //    古い窓に足し続けていると `startedAt` が t0 のままなので**常に許可**になる。
    const r = await reserveAttempt(KEY, POLICY, t1);
    expect(r.allowed, '窓明け後の試行が古い窓に足されている（制限が無効化されている）').toBe(
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
    const r = await reserveAttempt(KEY, POLICY, 2000);
    expect(r.allowed).toBe(true);
  });

  /** 実運用の方針でも上界・下界が成り立つ（定数を差し替えても壊れない）。 */
  it('実運用の kiosk 方針でも上界と下界が成り立つ', async () => {
    const now = 1_000_000;
    for (let i = 0; i < KIOSK_AUTHORIZE_POLICY.budget; i += 1) {
      expect((await reserveAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now)).allowed).toBe(true);
    }
    expect((await reserveAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now)).allowed).toBe(false);
    expect(
      (await reserveAttempt(KEY, KIOSK_AUTHORIZE_POLICY, now + KIOSK_AUTHORIZE_POLICY.windowMs))
        .allowed,
    ).toBe(true);
  });
});

/**
 * 層になった予算（#1021 AC4 / レビュー B1・B2）。
 *
 * ## 縛る不変条件
 *
 * > **他人の失敗で自分が閉まらない**（一次は発信元ごと）。
 * > かつ **global cap を置いた経路では総量も有界**（二次）。
 * > かつ **global cap を置かない経路では、他の発信元がいくら失敗しても入れる**（admin）。
 */
describe('層になった予算 (#1021 AC4)', () => {
  const LAYERS = {
    perOrigin: { budget: 2, windowMs: 60_000 } satisfies AttemptPolicy,
    global: { budget: 5, windowMs: 60_000 } satisfies AttemptPolicy,
  };
  const NO_CAP = { perOrigin: { budget: 2, windowMs: 60_000 } satisfies AttemptPolicy, global: undefined };

  /**
   * 🔴 **本体（レビュー B2 の核心）。** 発信元 A を使い切っても、発信元 B は入れる。
   * これが成り立たないと、攻撃者が運用者を無期限に閉め出せる。
   */
  it('🔴 他の発信元の失敗で閉まらない', async () => {
    for (let i = 0; i < LAYERS.perOrigin.budget; i += 1) {
      expect((await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000)).allowed).toBe(true);
    }
    expect((await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000)).allowed).toBe(false);
    // 🔴 別の発信元は影響を受けない。
    expect((await reserveLayered('ip:2.2.2.2', 'k', LAYERS, 1000)).allowed).toBe(true);
  });

  /** 🔴 上界: global cap を置いた経路では、発信元を回しても総量が有界。 */
  it('🔴 発信元を回しても global cap で止まる', async () => {
    let admitted = 0;
    for (let i = 0; i < 20; i += 1) {
      if ((await reserveLayered(`ip:10.0.0.${i}`, 'k', LAYERS, 1000)).allowed) admitted += 1;
    }
    expect(admitted).toBe(LAYERS.global.budget);
  });

  /**
   * 🔴 **下界（レビュー B2）。** global cap を置かない経路では、他の発信元が
   * いくら失敗しても入れる —— 運用者の入口を攻撃者に閉じさせない。
   */
  it('🔴 global cap が無い経路は、他の発信元の失敗で閉まらない', async () => {
    for (let i = 0; i < 50; i += 1) {
      await reserveLayered(`ip:10.0.0.${i % 5}`, 'a', NO_CAP, 1000);
    }
    expect((await reserveLayered('ip:203.0.113.9', 'a', NO_CAP, 1000)).allowed).toBe(true);
  });

  /** 🔴 識別できない要求は二重に数えない（一次と二次が同じ鍵になる）。 */
  it('🔴 global 退避の要求を二重に数えない', async () => {
    let admitted = 0;
    for (let i = 0; i < 10; i += 1) {
      if ((await reserveLayered(GLOBAL_IDENTITY, 'k', LAYERS, 1000)).allowed) admitted += 1;
    }
    // 一次（2）で止まる。二次を重ねて 1 回で 2 消費していれば 1 回しか入れない。
    expect(admitted).toBe(LAYERS.perOrigin.budget);
  });

  /** 🔴 成功は両層の窓を捨てる（正当な利用者の予算を削り残さない）。 */
  it('🔴 成功すると両層の予算が戻る', async () => {
    for (let i = 0; i < LAYERS.perOrigin.budget; i += 1) {
      await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000);
    }
    expect((await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000)).allowed).toBe(false);
    await recordLayeredSuccess('ip:1.1.1.1', 'k');
    expect((await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000)).allowed).toBe(true);
  });

  /** 🔴 scope が違えば独立（kiosk の失敗が admin を閉めない）。 */
  it('🔴 scope が違えば独立して数える', async () => {
    for (let i = 0; i < LAYERS.perOrigin.budget; i += 1) {
      await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000);
    }
    expect((await reserveLayered('ip:1.1.1.1', 'k', LAYERS, 1000)).allowed).toBe(false);
    expect((await reserveLayered('ip:1.1.1.1', 'a', NO_CAP, 1000)).allowed).toBe(true);
  });
});
