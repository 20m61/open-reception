/**
 * 認証試行の予算判定（#1021 AC4）。
 *
 * ## 何を守るか
 *
 * `/api/kiosk/authorize` は**未認証の公開経路**で、PIN は事実上 4 桁＝10^4 しかない。
 * 試行回数制限が無いので総当たりが現実的で、通れば **30 日の kiosk セッション**が出る
 * （以降 #1020 の面が全部開く）。`/api/admin/login` は全テナントの PII へ到達する。
 *
 * 🔴 **AC3 が未認証経路に計算コストを持ち込んだ。** PIN 照合は PBKDF2（実測 約 5ms/回）
 * になったので、叩くだけで Lambda の GB-ms と同時実行を消費させられる。
 * **予算超過の試行は照合そのものを走らせない**ことで、この増幅を閉じる側に使う。
 *
 * ## 縛る不変条件（機構より先に書く）
 *
 * 片側だけでは空虚に満たせるので、**両方**を縛る:
 *
 * > **上界**: 窓の中で予算を超えた試行は拒否される（総当たりが現実的でなくなる）。
 * > **下界**: 窓が明ければ**正当な入力は必ず通る**（恒久的な締め出しを作らない）。
 *
 * 上界だけなら「全部拒否」で満たせる ―― それは受付を止めるので、来訪者導線の破壊である。
 * 下界だけなら「何もしない」で満たせる ―― それが今日の状態である。
 *
 * ## なぜ来訪者側は「ロックアウト」にしないか
 *
 * ロックアウトを **kioskId** に掛けると、攻撃者が故意に失敗させて**受付窓口を閉鎖**できる。
 * **IP** に掛けると、建物の NAT を共有する**来訪者全員が一緒に閉め出される**一方、
 * 攻撃者は回線を変えれば素通りする。どちらも保護を**受付完遂への攻撃**に変える。
 *
 * だから来訪者側は「遅らせる（`retryAfterMs` を返して即座に断る）」に留め、
 * **恒久的に閉じない**。予算は**人間の打ち間違い（1〜3 回）が届かない**大きさに取る。
 */
import { describe, expect, it } from 'vitest';
import {
  consumeAttempt,
  type AttemptPolicy,
  type AttemptWindow,
  KIOSK_AUTHORIZE_POLICY,
  ADMIN_LOGIN_POLICY,
} from './attempt-budget';

/** 判定は純関数。窓の状態と現在時刻を渡す。 */
const POLICY: AttemptPolicy = { budget: 3, windowMs: 60_000 };

const windowAt = (startedAt: number, failures: number): AttemptWindow => ({ startedAt, failures });

describe('予算判定 (#1021 AC4)', () => {
  describe('上界: 予算を超えた試行は断る', () => {
    it('予算内なら許可する', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 2), 1500);
      expect(r.allowed).toBe(true);
    });

    it('🔴 予算に達したら断る', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 3), 1500);
      expect(r.allowed).toBe(false);
    });

    it('🔴 予算を超えていても断り続ける（1 回だけ漏らさない）', () => {
      for (const failures of [3, 4, 10, 1000]) {
        expect(consumeAttempt(POLICY, windowAt(1000, failures), 1500).allowed).toBe(false);
      }
    });

    /**
     * 🔴 **断るときは、いつ再試行できるかを返す。**
     * 返さないと画面が「あとどれだけ待つか」を言えず、来訪者は**無言の拒否**を見る。
     */
    it('🔴 断るときは残り時間を返す', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 3), 1500);
      expect(r.allowed).toBe(false);
      if (r.allowed) throw new Error('unreachable');
      expect(r.retryAfterMs).toBe(60_000 - 500);
      expect(r.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('下界: 窓が明ければ必ず通る（恒久的に閉じない）', () => {
    /**
     * 🔴 **本体。** これが無いと「全部拒否」で上界を満たせてしまい、受付が止まる。
     */
    it('🔴 窓が明けたら、失敗が何回あっても許可する', () => {
      for (const failures of [3, 10, 10_000]) {
        const r = consumeAttempt(POLICY, windowAt(1000, failures), 1000 + POLICY.windowMs);
        expect(r.allowed, `failures=${failures} で窓明け後も断られた`).toBe(true);
      }
    });

    /** 🔴 窓が明けたら失敗数を捨てる（次の窓へ持ち越さない＝累積で閉じない）。 */
    it('🔴 窓明けの許可は失敗数をリセットする', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 10), 1000 + POLICY.windowMs);
      expect(r.allowed).toBe(true);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.nextWindow.failures).toBe(0);
      expect(r.nextWindow.startedAt).toBe(1000 + POLICY.windowMs);
    });

    /** 🔴 窓の**境界ちょうど**で明ける（オフバイワンで 1 窓分長く閉じない）。 */
    it('🔴 窓の境界ちょうどで明ける', () => {
      expect(consumeAttempt(POLICY, windowAt(1000, 3), 1000 + POLICY.windowMs).allowed).toBe(true);
      // すぐ内側はまだ閉じている（境界を緩める変異を落とす）。
      expect(consumeAttempt(POLICY, windowAt(1000, 3), 1000 + POLICY.windowMs - 1).allowed).toBe(
        false,
      );
    });

    /** 窓が無い（初回）なら許可し、窓を開く。 */
    it('初回は許可して窓を開く', () => {
      const r = consumeAttempt(POLICY, undefined, 5000);
      expect(r.allowed).toBe(true);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.nextWindow).toEqual({ startedAt: 5000, failures: 0 });
    });
  });

  describe('予算の値', () => {
    /**
     * 🔴 **来訪者側の予算は、人間の打ち間違いが届かない大きさにする。**
     *
     * 4 桁を打ち間違えるのは 1〜3 回で、10 回は打たない。ここが小さいと
     * **正当な来訪者が受付できなくなる**（保護ではなく受付への攻撃になる）。
     */
    it('🔴 kiosk の予算は人間の打ち間違いより大きい', () => {
      expect(KIOSK_AUTHORIZE_POLICY.budget).toBeGreaterThanOrEqual(5);
    });

    /**
     * 🔴 **上界も要る。** 予算が大きすぎると総当たりが現実的に戻る。
     * 10^4 を予算×(1 時間/窓) で割った時間が、実用的でない長さに収まること。
     */
    it('🔴 kiosk の予算は総当たりを現実的にしない', () => {
      const perHour = KIOSK_AUTHORIZE_POLICY.budget * (3_600_000 / KIOSK_AUTHORIZE_POLICY.windowMs);
      // 10^4 を尽くすのに 24 時間以上かかること。
      expect(10_000 / perHour).toBeGreaterThan(24);
    });

    /** 🔴 admin 側はより厳しい（来訪者導線ではなく、価値がはるかに高い）。 */
    it('🔴 admin の予算は kiosk より厳しい', () => {
      const adminPerHour = ADMIN_LOGIN_POLICY.budget * (3_600_000 / ADMIN_LOGIN_POLICY.windowMs);
      const kioskPerHour =
        KIOSK_AUTHORIZE_POLICY.budget * (3_600_000 / KIOSK_AUTHORIZE_POLICY.windowMs);
      expect(adminPerHour).toBeLessThan(kioskPerHour);
    });

    /** 窓は TTL で自然消滅させるので、無限に伸ばさない（掃除が要らない長さ）。 */
    it('窓は有限（TTL で消える長さ）', () => {
      for (const p of [KIOSK_AUTHORIZE_POLICY, ADMIN_LOGIN_POLICY]) {
        expect(p.windowMs).toBeGreaterThan(0);
        expect(p.windowMs).toBeLessThanOrEqual(3_600_000);
      }
    });
  });

  /**
   * 🔴 **成功は窓を閉じる（失敗数を捨てる）。**
   * 捨てないと、正しく入った直後に予算切れで断られる形が残る。
   */
  describe('成功の扱い', () => {
    it('🔴 成功したら失敗数をリセットする', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 2), 1500);
      expect(r.allowed).toBe(true);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.onSuccess.failures).toBe(0);
    });

    /** 🔴 失敗は数え上がる（下界だけ満たして数えない実装を落とす）。 */
    it('🔴 失敗したら失敗数が 1 増える', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 2), 1500);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.onFailure.failures).toBe(3);
      // 窓の開始時刻は動かさない（失敗ごとに窓を伸ばすと恒久的に閉じうる）。
      expect(r.onFailure.startedAt).toBe(1000);
    });
  });
});
