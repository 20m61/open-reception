/**
 * 担当者画面の失敗を、画面に出す文言へ写す (#1123)。
 *
 * ## なぜ分けるか
 *
 * `StaffCallView` / `StaffResponseActions` は非 ok を一括で `error` にし、
 * 「**リンクの有効期限切れ**、または…の可能性があります」と出していた。#1021 で
 * `CALL_ANSWER_SECRET` が failClosed になり担当者向け API が **5xx を返しうる**ように
 * なったので、**サーバの設定漏れでも「リンク切れ」と伝わる**状態になった。
 *
 * 🔴 これは #973 が admin ログインで塞ぎ、#1021 が `loginFailureForStatus` で塞ぎ直したのと
 * **同型・同一原因**（failClosed が新しい応答クラスを作ったこと）である。同じ形で解く。
 *
 * 縛る不変条件は 1 つ:
 *
 * > 「リンクの有効期限切れ」と出してよいのは、**サーバが要求を検査したうえで断ったとき
 * > （アプリが返した 4xx）だけ**である。5xx はサーバ側の問題で、リンクは無関係。
 *
 * 🔴 **縛れたのは片側だけである。** 「5xx ならサーバ側の問題」は成立するが、その裏
 * （「4xx なら要求が判定された」）は**成立していない** —— `src/proxy.ts` の origin-verify
 * `mismatch`（配備の全断なのに 403）に加え、**この increment が編集した route 自身**が
 * 設定不備を 4xx で返している: `answer` はテナントに Vonage 資格情報が無いと **409**
 * `{error:'unavailable'}`（未設定が既定状態）、`respond` は `409 action_disabled` 等。
 * これらは今も `rejected`＝「リンクの有効期限切れ」と表示される。
 * **「もう塞いだ」と読ませない。** 揃えるのは #1127 の射程（レビュー 6 周目の実測）。
 *
 * 🔴 **文言に env 名・鍵名を出さない。** 担当者リンクは通知で配られ、**未認証で開かれる**
 * （リンクを持っている人、でしかない）。設定の内訳は攻撃者への情報になる
 * （`rules/pii-secret-minimization.md`）。原因の特定はサーバログ側の仕事。
 */
import { isServerSideFailure } from '@/domain/util/http-failure';

/** 担当者操作の失敗。**原因が違えば担当者にできることも違う**ので、同じ値にしない。 */
export type StaffFailure =
  /** サーバが**要求を検査したうえで**断った（4xx）。リンク切れ・応答済み・受付終了など。 */
  | 'rejected'
  /**
   * サーバ側の問題で処理できなかった（5xx）。
   *
   * 🔴 #1123 で `/api/staff/calls/*` は鍵未設定のとき **503** を返すようになった。
   * 担当者にできることは「リンクを取り直す」ではなく「時間をおく・運用者へ知らせる」。
   */
  | 'unavailable'
  /**
   * 通話を確立できなかった。**成否は分かっていない**。
   *
   * 2 つの経路が入る:
   * - `fetch` が reject（オフライン・DNS 失敗）—— サーバは要求を見ていない
   * - 🔴 Vonage の `onError` —— **answer API は 200 を返し終えており、サーバは受付を
   *   `connected` に確定済み**。つまり「受付は応答済み、通話には誰も居ない」状態で、
   *   文言の「通信状態を確かめて、もう一度お試しください」は**この経路では正確でない**
   *   （再試行の導線も無い）。変更前は「リンクの有効期限切れ」という別の嘘だったので
   *   退行ではないが、**正しい扱いは #1129**（担当者の復帰導線と、来訪者側の状態のずれ）。
   *
   * 🔴 **しかも今日この経路は「常に」発火する。** `src/lib/security/csp.ts` の
   *   `script-src 'self' 'nonce-…'` は Vonage SDK の CDN を許可していないので、
   *   ブラウザが読み込み自体を拒否する（レビュー 6 周目の実測）。つまり文言は
   *   **利用者の回線のせいにしている**が、原因は配信側の設定である —— #1123 が
   *   消そうとしている嘘と同型。#1132 で扱う（本 increment の射程外）。
   */
  | 'unreachable';

/**
 * HTTP 応答の状態コードを失敗の種類へ写す。
 *
 * 状態コードを見ずに「非 ok はすべて `rejected`」にすると、#973 が塞いだ嘘を
 * **別の入口（5xx）から踏み直す**ことになる —— #1021 の admin 側で実際に踏んだ。
 */
export function staffFailureForStatus(status: number): StaffFailure {
  return isServerSideFailure(status) ? 'unavailable' : 'rejected';
}

/** 通話への参加に失敗したときの文言。 */
export function staffCallFailureMessage(failure: StaffFailure): string {
  switch (failure) {
    case 'rejected':
      return '通話に接続できませんでした。リンクの有効期限切れ、または別の端末で応答済みの可能性があります。';
    case 'unavailable':
      return 'サーバー側の問題で通話に接続できませんでした。時間をおいても直らない場合は、管理者へ知らせてください。';
    case 'unreachable':
      return 'サーバーに接続できませんでした。通信状態を確かめて、もう一度お試しください。';
  }
}

/** 応答種別の送信に失敗したときの文言。 */
export function staffResponseFailureMessage(failure: StaffFailure): string {
  switch (failure) {
    case 'rejected':
      return '応答を送れませんでした。リンクの有効期限切れ、または受付が終了している可能性があります。';
    case 'unavailable':
      return 'サーバー側の問題で応答を送れませんでした。時間をおいても直らない場合は、管理者へ知らせてください。';
    case 'unreachable':
      return 'サーバーに接続できませんでした。応答が届いたか分かりません。通信状態を確かめてから、もう一度お試しください。';
  }
}
