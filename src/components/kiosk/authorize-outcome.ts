/**
 * 受付端末の PIN 許可の失敗を、画面に出す文言へ写す (#1021 AC4)。
 *
 * ## なぜ分けるか
 *
 * PIN 画面は非 ok を**一括で**「**PIN が正しくありません。**」にしていた。AC4 で
 * 429（試行回数制限）が返りうるようになったので、そのままだと**正しい PIN を入れた
 * 来訪者に「PIN が違う」と言う**ことになる。来訪者は自分の PIN を疑って打ち直し続け、
 * その間ずっと受付できない。
 *
 * 🔴 これは #973（admin ログイン）・#1021 増分 1（`loginFailureForStatus`）・#1123
 * （担当者画面）が**すでに 3 回塞いでいる型**である。4 回目を作らない ——
 * 先例と同じ形（status → 原因の純関数 ＋ 原因ごとの文言）で解く。
 *
 * 🔴 **文言に env 名・鍵名・アルゴリズム名を出さない。** この画面は**未認証で開かれる**
 * （`rules/pii-secret-minimization.md`）。
 */
import { isServerSideFailure } from '@/domain/util/http-failure';

/** PIN 許可の失敗。**原因が違えば来訪者にできることも違う**ので、同じ値にしない。 */
export type AuthorizeFailure =
  /** サーバが検査したうえで断った（401/403）。PIN が違う、または PIN 認可が無効。 */
  | 'wrong_pin'
  /**
   * 試行回数の予算を使い切った（429）。
   *
   * 🔴 **来訪者に落ち度は無い。** サイト全体で数えているので、**別の誰か**（多くは
   * 総当たりを試みている側）の失敗で閉まる。PIN を疑わせてはいけない。
   */
  | 'too_many_attempts'
  /** サーバ側の問題（5xx）。設定漏れなど。来訪者にできることは無い。 */
  | 'unavailable'
  /** 応答が返らなかった。届いたか分からない。 */
  | 'unreachable';

/** HTTP 応答の状態コードを失敗の種類へ写す。 */
export function authorizeFailureForStatus(status: number): AuthorizeFailure {
  if (status === 429) return 'too_many_attempts';
  return isServerSideFailure(status) ? 'unavailable' : 'wrong_pin';
}

/**
 * 失敗の文言。
 *
 * `retryAfterSec` は `Retry-After` ヘッダの秒数（分からなければ `undefined`）。
 * 🔴 **`undefined` で「NaN 秒」と出さない。** 分からないときは秒数を言わない形に落とす。
 */
export function authorizeFailureMessage(
  failure: AuthorizeFailure,
  retryAfterSec: number | undefined,
): string {
  switch (failure) {
    case 'wrong_pin':
      return 'PIN が正しくありません。もう一度入力してください。';
    case 'too_many_attempts': {
      // 🔴 **PIN を疑わせない。** 閉まった原因は来訪者ではない。
      // 🔴 **次の一手を残す。** 待つだけしか言わないと来訪者は立ち尽くす。
      const wait =
        retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? `約 ${Math.ceil(retryAfterSec)} 秒後にもう一度お試しください。`
          : 'しばらくしてからもう一度お試しください。';
      return `入力の試行が続いたため、一時的に受付の開始を制限しています。${wait}お急ぎの場合は担当者へお声がけください。`;
    }
    case 'unavailable':
      return 'サーバー側の問題で受付を開始できませんでした。担当者へお声がけください。';
    case 'unreachable':
      return '受付を開始できませんでした。通信状態を確かめてから、もう一度お試しください。';
  }
}

/**
 * 画面が持つ失敗の状態。
 *
 * 🔴 **原因を既定値で補わない。** `boolean` で持って非 ok を全部 1 つの文言へ丸めるのが
 * 元の形で、429 が返るようになった時点で**嘘**になった。原因を伴わない error を
 * **表現不能**にしておく（`StaffResponseActions` が #1123 で採ったのと同じ形）。
 */
export type AuthorizeState =
  | { kind: 'idle' }
  | { kind: 'error'; failure: AuthorizeFailure; retryAfterSec: number | undefined };

/**
 * `fetch` の応答から画面の状態を作る。**配線をこの 1 式に寄せてある。**
 *
 * 🔴 **なぜ関数にしたか（#826 の教訓）。** 純関数の分岐を全部 kill しても、
 * **呼び出し側（配線）を変異させていない**と保証は丸ごと落ちる —— #826 では
 * `KioskFlow` を元へ戻しても unit・e2e とも緑だった。このリポジトリには対話的な
 * component テストの仕組みが無く、429 の e2e も**サイト全体の予算を使い切ると
 * スイートを汚染する**ため書けない。だから配線を**テストできる 1 式**へ寄せ、
 * 残った 1 行は `authorize-wiring.test.ts` が静的に固定する。
 */
export function authorizeStateFromResponse(
  status: number,
  retryAfterHeader: string | null,
): AuthorizeState {
  const parsed = retryAfterHeader !== null ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
  return {
    kind: 'error',
    failure: authorizeFailureForStatus(status),
    // 🔴 `Number.isFinite` を外すと「約 NaN 秒後」と出る（変異 M34 が生存した穴）。
    retryAfterSec: Number.isFinite(parsed) ? parsed : undefined,
  };
}
