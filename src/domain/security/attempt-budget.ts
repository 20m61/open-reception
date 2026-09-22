/**
 * 認証試行の予算判定（#1021 AC4）。**純関数**で、状態と時刻は呼び出し側が持つ。
 *
 * ## 縛る不変条件
 *
 * > **上界**: 窓の中で予算を超えた試行は拒否される（総当たりが現実的でなくなる）。
 * > **下界**: 窓が明ければ**正当な入力は必ず通る**（恒久的な締め出しを作らない）。
 *
 * 片側だけでは空虚に満たせる ―― 上界だけなら「全部拒否」、下界だけなら「何もしない」
 * （後者が今日の状態）。判定を 1 箇所に閉じ、両側をテストで縛る。
 *
 * ## なぜ来訪者側を「ロックアウト」にしないか
 *
 * ロックアウトを **kioskId** に掛けると、攻撃者が故意に失敗させて**受付窓口を閉鎖**できる。
 * **IP** に掛けると、建物の NAT を共有する**来訪者全員が一緒に閉め出される**一方、
 * 攻撃者は回線を変えれば素通りする。どちらも保護を**受付完遂への攻撃**へ変える。
 *
 * だから来訪者側は「遅らせる（`retryAfterMs` を返して**即座に**断る）」に留める。
 * 🔴 **待たせるために応答を保留しない。** Lambda では待ち時間そのものに課金されるので、
 * 「sleep してから返す」は #1021 AC3 が持ち込んだ計算増幅を**悪化させる**。
 * 即座に断り、**呼び出し側は PBKDF2 照合を走らせない** ―― 予算超過の試行は
 * コストが上がるのではなく**下がる**。
 */

/** 試行予算の方針。`windowMs` の間に `budget` 回の失敗まで許す。 */
export type AttemptPolicy = {
  /** 窓の中で許す失敗回数。 */
  readonly budget: number;
  /** 窓の長さ（ミリ秒）。 */
  readonly windowMs: number;
};

/** 窓の状態（永続化する値）。 */
export type AttemptWindow = {
  /** 窓を開いた時刻（epoch ms）。失敗では動かさない。 */
  readonly startedAt: number;
  /** 窓の中で数えた失敗回数。 */
  readonly failures: number;
};

/** 判定結果。許可なら次に書く窓を、拒否なら再試行可能になるまでの時間を返す。 */
export type AttemptDecision =
  | {
      readonly allowed: true;
      /** 判定の結果として書くべき窓（窓明けならリセット済み）。 */
      readonly nextWindow: AttemptWindow;
      /** 照合が**成功**したときに書く窓（失敗数を捨てる）。 */
      readonly onSuccess: AttemptWindow;
      /** 照合が**失敗**したときに書く窓（失敗数を 1 増やす）。 */
      readonly onFailure: AttemptWindow;
    }
  | {
      readonly allowed: false;
      /** 再試行できるようになるまでの時間（ミリ秒）。必ず正。 */
      readonly retryAfterMs: number;
    };

/**
 * 🔴 **来訪者側（`/api/kiosk/authorize`）の方針。**
 *
 * 予算は**人間の打ち間違いが届かない**大きさに取る ―― 4 桁を打ち間違えるのは 1〜3 回で、
 * 10 回は打たない。小さすぎると**正当な来訪者が受付できなくなる**（保護ではなく攻撃になる）。
 *
 * 一方で総当たりは現実的でなくしたい: 10 回/10 分 = 60 回/時間なので、10^4 を尽くすのに
 * **約 167 時間（7 日）** かかる。窓は TTL で自然消滅する長さに収める。
 */
export const KIOSK_AUTHORIZE_POLICY: AttemptPolicy = { budget: 10, windowMs: 600_000 };

/**
 * 🔴 **運用者側（`/api/admin/login`）の方針。**
 *
 * 来訪者導線ではないので厳しくしてよい。資格情報の価値は桁違いに高く
 * （全テナントの設定・監査ログ・予約 PII に到達する）、ログインの頻度は 1 日数回である。
 * 5 回/15 分 = 20 回/時間。
 */
export const ADMIN_LOGIN_POLICY: AttemptPolicy = { budget: 5, windowMs: 900_000 };

/**
 * 試行を 1 つ消費してよいかを判定する。
 *
 * 🔴 **窓明けの判定は `>=`（境界ちょうどで明ける）。** `>` にすると 1 窓分だけ長く
 * 閉じたままになり、下界（「窓が明けば必ず通る」）が境界で破れる。
 */
export function consumeAttempt(
  policy: AttemptPolicy,
  window: AttemptWindow | undefined,
  now: number,
): AttemptDecision {
  const fresh: AttemptWindow = { startedAt: now, failures: 0 };
  // 窓が無い（初回）、または窓が明けた → 新しい窓で許可する。
  if (window === undefined || now - window.startedAt >= policy.windowMs) {
    return {
      allowed: true,
      nextWindow: fresh,
      onSuccess: fresh,
      onFailure: { startedAt: now, failures: 1 },
    };
  }
  if (window.failures >= policy.budget) {
    // 🔴 **必ず正の値を返す。** 0 や負を返すと、呼び出し側の `Retry-After` が
    //    「すぐ再試行してよい」になり、上界が事実上消える。
    const remaining = policy.windowMs - (now - window.startedAt);
    return { allowed: false, retryAfterMs: Math.max(1, remaining) };
  }
  return {
    allowed: true,
    nextWindow: window,
    // 🔴 成功したら失敗数を捨てる（正しく入った直後に予算切れで断られる形を作らない）。
    onSuccess: { startedAt: window.startedAt, failures: 0 },
    // 🔴 失敗では窓の開始時刻を動かさない（失敗ごとに窓を伸ばすと恒久的に閉じうる）。
    onFailure: { startedAt: window.startedAt, failures: window.failures + 1 },
  };
}
