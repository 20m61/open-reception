/**
 * 管理ログインの送信結果を、画面に出す文言へ写す (#973)。
 *
 * ## なぜ分けるか
 *
 * それまで `AdminPasswordLogin` は `try { … } finally { setBusy(false) }` で、**`catch` が
 * 無かった**。`fetch` が reject する経路（オフライン・DNS 失敗・API が落ちている）では
 * 押しても**何も起きない** —— ボタンが戻るだけで、画面にも読み上げにも何も出ない。
 * 運用者は「パスワードが違うのか、押せていないのか」を区別できず、同じ操作を繰り返す。
 *
 * 🔴 **`catch` で `setError(true)` にしてはいけない。** それは
 * 「パスワードが正しくありません」と**嘘をつく**ことになる（通信が届いていないので、
 * サーバはパスワードを見てすらいない）。原因の異なる失敗は別の文言にする ――
 * `.claude/rules/opus5-autonomous-loop.md`「果たせない約束をしない」と同じ根。
 *
 * ここを純関数にしてあるのは、この写像だけを unit で縛れるようにするため
 * （このリポジトリの component テストは `renderToStaticMarkup` で、送信の相互作用は
 * e2e 側にある）。
 */

/** ログイン送信の失敗。**原因が違えば運用者にできることも違う**ので、同じ値にしない。 */
export type LoginFailure =
  /** サーバが**パスワードを検査したうえで**拒否した（401）。押し直しても同じ。 */
  | 'rejected'
  /** 応答が返らなかった／解釈できなかった。**パスワードの正否は分かっていない**。 */
  | 'unreachable'
  /**
   * サーバは応答したが、**パスワードを検査する前に**失敗した（5xx / 409 等）。
   *
   * 🔴 これは #1021 で**新しく起こりうるようになった**。`ADMIN_PASSWORD` を入れ忘れた
   * デプロイでは `serverSecret()` が fail-closed で throw するので、route は 401 ではなく
   * **500** を返す。運用者にできることは「パスワードを打ち直す」ではなく
   * 「サーバーの設定を直す」なので、`rejected` と同じ値にしてはいけない。
   */
  | 'server_error'
  /**
   * 試行回数の予算を使い切った（429。#1021 AC4 で新設）。
   *
   * 🔴 **`server_error` と同じ値にしてはいけない（Codex レビュー P2）。** 一緒にすると
   * 運用者は「サーバーの設定を確認してください」と読み、**設定を疑って調べに行く** ——
   * 実際にすべきことは「少し待って、もう一度」である。`Retry-After` も無視されていた。
   *
   * 🔴 これは #973 が塞ぎ、#1021 増分 1 が `loginFailureForStatus` で塞ぎ直し、#1123 が
   * 担当者画面で塞いだのと**同型**である。同じ増分で kiosk 側には対策を入れておきながら、
   * **admin 側に入れ忘れていた** —— `CLAUDE.md` が #788 で記録している
   * 「同型の 2 本には対策を入れており、3 本目にだけ入れ忘れていた」そのものである。
   */
  | 'too_many_attempts';

/**
 * 画面と読み上げに出す文言。
 *
 * 🔴 **`unreachable` で原因を断定しない。** 「サーバが落ちています」と書くと、実際には
 * 端末側がオフラインのときに嘘になる。分かっているのは「届かなかった」ことだけである。
 *
 * 🔴 **`server_error` で具体的な env 名を出さない。** ログイン画面は未認証で誰でも見える。
 * 「どの秘密が入っていないか」は攻撃者への情報になる。原因の特定はサーバログ側の仕事で、
 * `serverSecret()` が env 名つきで throw する。
 */
export function loginFailureMessage(
  failure: LoginFailure,
  retryAfterSec?: number | undefined,
): string {
  switch (failure) {
    case 'rejected':
      return 'パスワードが正しくありません。';
    case 'unreachable':
      return 'サーバーに接続できませんでした。通信状態を確かめて、もう一度お試しください。';
    case 'server_error':
      return 'サーバーがログインを処理できませんでした。パスワードの正否は確認されていません。時間をおいても直らない場合は、サーバーの設定を確認してください。';
    case 'too_many_attempts': {
      // 🔴 **設定を疑わせない。** 待てば直るので、待ち時間が分かるなら出す。
      //    `NaN` / 0 / 負で「約 NaN 秒後」と出さない（kiosk 側と同じ境界）。
      const wait =
        retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? `約 ${Math.ceil(retryAfterSec)} 秒後に`
          : 'しばらくしてから';
      return `ログインの試行が続いたため、一時的に受け付けを制限しています。${wait}もう一度お試しください。`;
    }
  }
}

/**
 * HTTP 応答の状態コードを失敗の種類へ写す。
 *
 * 🔴 **ここがこの写像の本体である。** 縛る不変条件は 1 つ:
 *
 * > 「パスワードが正しくありません」と出してよいのは、**サーバがパスワードを検査した
 * > うえで拒否したとき（401）だけ**である。
 *
 * 状態コードを見ずに「非 ok ならすべて `rejected`」にすると、#973 が塞いだ嘘を
 * **別の入口（5xx）から踏み直す**ことになる —— #1021 で実際に踏んだ。`ADMIN_PASSWORD`
 * を入れ忘れたデプロイで、画面に出るのは「パスワードが正しくありません。」だけだった。
 */
export function loginFailureForStatus(status: number): LoginFailure {
  // 🔴 429 は「待てば直る」。設定を疑わせる `server_error` へ丸めない（#1021 AC4）。
  if (status === 429) return 'too_many_attempts';
  return status === 401 ? 'rejected' : 'server_error';
}
