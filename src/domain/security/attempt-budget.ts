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
      /**
       * 予約の結果として書くべき窓（窓明けならリセット済み）。
       *
       * 🔴 **`onSuccess` / `onFailure` は撤回した（レビュー M5）。** 入場を予約する形に
       * 変えた時点で**本番の消費者がゼロ**になっており（シンボル走査とモジュールパス走査の
       * 2 通りで確認）、成功時の窓は `recordSuccess` の削除が代替している。
       * 残していると、それを縛る 4 本のテストが**本番挙動を何も守らないまま
       * kill 数を膨らませる** —— 被覆の主張が過大になる。
       */
      readonly nextWindow: AttemptWindow;
    }
  | {
      readonly allowed: false;
      /** 再試行できるようになるまでの時間（ミリ秒）。必ず正。 */
      readonly retryAfterMs: number;
    };

/**
 * 予算の方針は**層**になっている（#1021 AC4 / レビュー B1・B2）。
 *
 * - `perOrigin` … 一次。**発信元ごと**（非詐称可能な viewer IP）。他人の失敗で閉まらない
 * - `global` … 二次（backstop）。**無い経路もある** —— `undefined` は「その経路に
 *   global cap を置かない」という**明示的な判断**である
 *
 * 🔴 **admin には global cap を置かない。** 置くと、攻撃者が cap を使い切るだけで
 * **運用者が無期限に入れない**。そして kiosk の復旧経路（エンロール URL の発行）は
 * admin セッションを要求し、その入口は `/api/admin/login` だけなので、
 * **受付が復旧不能になる**（レビュー B2 の連鎖）。
 *
 * admin 側の実質的な守りは (a) 発信元ごとの予算、(b) パスワードのエントロピー、
 * (c) AC1 の fail-closed（公開既定値のデプロイを起動段で塞ぐ）である。
 * 分散総当たりは**この層では止めない** —— 止められると書かない。
 */
export type LayeredPolicy = {
  readonly perOrigin: AttemptPolicy;
  readonly global: AttemptPolicy | undefined;
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
 * 🔴 **kiosk の global cap は置く。** PIN は事実上 4 桁なので、発信元を回す分散総当たりを
 * 止める価値が実際にある。cap を使い切られると初回 PIN 認可が閉じるが、
 * **稼働中の端末は 30 日 cookie で動き続け、復旧経路（admin → エンロール発行）は
 * 別の層なので開いている**（admin に global cap を置かないのがその前提）。
 *
 * 60 回/10 分 = 360 回/時間。正常運用では 1 サイトで到達しない量である。
 */
export const KIOSK_AUTHORIZE_GLOBAL_POLICY: AttemptPolicy = { budget: 60, windowMs: 600_000 };

/** kiosk の層（一次＝発信元ごと、二次＝global cap）。 */
export const KIOSK_AUTHORIZE_LAYERS: LayeredPolicy = {
  perOrigin: KIOSK_AUTHORIZE_POLICY,
  global: KIOSK_AUTHORIZE_GLOBAL_POLICY,
};

/**
 * 🔴 **運用者側（`/api/admin/login`）の方針。**
 *
 * 来訪者導線ではないので厳しくしてよい。資格情報の価値は桁違いに高く
 * （全テナントの設定・監査ログ・予約 PII に到達する）、ログインの頻度は 1 日数回である。
 * 5 回/15 分 = 20 回/時間。
 */
export const ADMIN_LOGIN_POLICY: AttemptPolicy = { budget: 5, windowMs: 900_000 };

/**
 * admin の層。🔴 **`global: undefined` は意図である**（上の `LayeredPolicy` の doc を参照）——
 * global cap を置くと運用者を無期限に閉め出せ、受付の復旧経路が閉じる。
 */
export const ADMIN_LOGIN_LAYERS: LayeredPolicy = {
  perOrigin: ADMIN_LOGIN_POLICY,
  global: undefined,
};

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
    return { allowed: true, nextWindow: fresh };
  }
  if (window.failures >= policy.budget) {
    // 🔴 **クランプは撤回した（変異検証で生存＝等価）。** ここへ来る時点で上の分岐
    //    （`now - startedAt >= windowMs`）が偽なので `remaining > 0` は構造から従う。
    //    境界を守っているのは上の `>=` であり、その変異はテストで落ちる（M1）。
    //    「守るものが無い機構は撤回する」（`.claude/rules/opus5-autonomous-loop.md`）。
    return { allowed: false, retryAfterMs: policy.windowMs - (now - window.startedAt) };
  }
  // 🔴 窓の開始時刻を動かさない（試行ごとに窓を伸ばすと恒久的に閉じうる）。
  return { allowed: true, nextWindow: window };
}
