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
 * ## 鍵の選び方（当初の判断は誤りだった）
 *
 * 🔴 **当初は「非詐称可能な識別子は無い」として鍵を global 1 本にしていた。**
 * それは `kiosk/authorize` が読んでいる `x-forwarded-for` の**先頭**（詐称可能）から
 * 一般化した誤りで、独立レビューが反証した ——
 * `src/lib/admin/audit.ts` は**末尾**（CloudFront が付ける実 client IP）を採っており、
 * `src/proxy.ts` の origin-verify が CloudFront 迂回を**全ルートで**拒否する。
 * 本番では**末尾は詐称できない**。
 *
 * global 1 本だと攻撃者が少量のリクエストで**運用者を無期限に閉め出せ**、
 * kiosk の復旧経路（エンロール URL の発行 = admin セッション必須）も同じ形で閉じられて
 * **受付が復旧不能**になった。今は `LayeredPolicy` のとおり
 * **一次 = 発信元ごと / 二次 = global cap（admin には置かない）** にしてある。
 *
 * ## それでもロックアウトを短く保つ
 *
 * 一次が発信元ごとでも、来訪者側は「遅らせる（`retryAfterMs` を返して**即座に**断る）」に
 * 留める —— 端末は 1 つの発信元なので、長く閉じると**その端末の受付が止まる**。
 * 予算は**人間の打ち間違い（1〜3 回）が届かない**大きさに取る。
 */
import { describe, expect, it } from 'vitest';
import {
  consumeAttempt,
  type AttemptPolicy,
  type AttemptWindow,
  KIOSK_AUTHORIZE_POLICY,
  KIOSK_AUTHORIZE_LAYERS,
  ADMIN_LOGIN_POLICY,
  ADMIN_LOGIN_LAYERS,
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

    /**
     * 🔴 **窓明けの許可は窓を開き直す。**
     *
     * `nextWindow` は**本番が読む唯一のフィールド**である（`onSuccess` / `onFailure` は
     * 消費者ゼロだったので撤回した。レビュー M5）。開き直さないと `startedAt` が動かず、
     * 以後 `checkAttempt` が常に「窓が明けている」と判定して
     * **制限が恒久的に無効化される**。
     */
    it('🔴 窓明けの許可は窓を開き直す', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 10), 1000 + POLICY.windowMs);
      expect(r.allowed).toBe(true);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.nextWindow).toEqual({ startedAt: 1000 + POLICY.windowMs, failures: 0 });
    });

    /** 🔴 窓の中の許可は窓を動かさない（試行ごとに伸ばすと恒久的に閉じうる）。 */
    it('🔴 窓の中の許可は startedAt を動かさない', () => {
      const r = consumeAttempt(POLICY, windowAt(1000, 1), 1500);
      if (!r.allowed) throw new Error('unreachable');
      expect(r.nextWindow.startedAt).toBe(1000);
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
});

/**
 * 層の方針そのもの（#1021 AC4 / レビュー B1・B2）。
 *
 * 🔴 **これらは変異検証で生存した穴である。** 層化の**振る舞い**は
 * `attempt-store.test.ts` が縛っていたが、**方針の定数**を誰も縛っていなかったので、
 * `ADMIN_LOGIN_LAYERS.global` に cap を入れる変異（＝B2 を戻す変異）が素通りした。
 */
describe('層の方針 (#1021 AC4)', () => {
  /**
   * 🔴 **本体（B2 の核心を定数で縛る）。** admin に global cap を置くと、
   * 攻撃者が cap を使い切るだけで**運用者が無期限に入れない**。そして kiosk の
   * 復旧経路（エンロール URL の発行）は admin セッション必須で、その入口は
   * `/api/admin/login` だけなので、**受付が復旧不能になる**。
   */
  it('🔴 admin には global cap を置かない（受付の復旧経路を閉じさせない）', () => {
    expect(
      ADMIN_LOGIN_LAYERS.global,
      'admin に global cap を置くと攻撃者が運用者を無期限に閉め出せる（レビュー B2）',
    ).toBeUndefined();
  });

  /** 🔴 下界: kiosk には置く（PIN が 4 桁なので分散総当たりを止める価値がある）。 */
  it('🔴 kiosk には global cap を置く（下界）', () => {
    expect(KIOSK_AUTHORIZE_LAYERS.global).toBeDefined();
  });

  /** 🔴 一次は両経路とも定数と一致している（層の配線が入れ替わっていない）。 */
  it('🔴 一次の方針は各経路の予算と一致する', () => {
    expect(KIOSK_AUTHORIZE_LAYERS.perOrigin).toBe(KIOSK_AUTHORIZE_POLICY);
    expect(ADMIN_LOGIN_LAYERS.perOrigin).toBe(ADMIN_LOGIN_POLICY);
  });

  /**
   * 🔴 **global cap の大きさに上界を置く（変異検証で生存した穴）。**
   *
   * cap が巨大だと「発信元を回す分散総当たり」を止められない ―― cap を置いた意味が消える。
   * 10^4 を cap で割った時間が実用的でない長さに収まること。
   */
  it('🔴 kiosk の global cap は分散総当たりを現実的にしない', () => {
    const cap = KIOSK_AUTHORIZE_LAYERS.global;
    expect(cap).toBeDefined();
    if (cap === undefined) throw new Error('unreachable');
    const perHour = cap.budget * (3_600_000 / cap.windowMs);
    // 10^4 を尽くすのに 24 時間以上かかること。
    expect(10_000 / perHour).toBeGreaterThan(24);
  });

  /**
   * 🔴 **下界: cap は一次より十分大きい。** 一次と同じか小さいと、
   * 1 つの発信元の失敗で**全体が閉まる**（B2 が別の綴りで戻る）。
   */
  it('🔴 global cap は一次予算より十分大きい（1 発信元で全体を閉じさせない）', () => {
    const cap = KIOSK_AUTHORIZE_LAYERS.global;
    if (cap === undefined) throw new Error('unreachable');
    expect(cap.budget).toBeGreaterThan(KIOSK_AUTHORIZE_LAYERS.perOrigin.budget * 2);
  });
});
