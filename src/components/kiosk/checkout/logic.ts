/**
 * 受付端末 退館フローの純ロジック (issue #102, increment 1 / #327 i18n 化)。
 *
 * 画面（CheckoutFlow）から副作用のない型・文言マッピングを切り出し、node 環境で検証する。
 * 文言には PII を含めない。文言そのものは `src/lib/i18n` のカタログが正であり、本関数は
 * 失敗理由 → `MessageKey` の対応表として振る舞う（`tr` に翻訳関数 `makeT(locale)` を渡す）。
 */
import type { MessageKey } from '@/lib/i18n';

/** 退館フローの画面状態。 */
export type CheckoutFlowState = 'input' | 'done';

/**
 * 在館中サマリ（PII を含まない）。#328 で判別材料（呼び出し先ラベル・用件）を追加。
 * 氏名等 PII は含めない（`rules/pii-secret-minimization.md`）。
 */
export type PresentStaySummary = {
  stayId: string;
  checkedInAt: string;
  /** 呼び出し先ラベル（部署・担当の表示名。非 PII）。 */
  targetLabel?: string;
  /** 用件（目的種別ラベル。非 PII）。 */
  purpose?: string;
};

/**
 * 退館の自己特定サマリ（確認ステップ表示用・非 PII）。
 *
 * 🔴 **再宣言せず、サーバが返す型そのものを再輸出する**（独立レビュー 2 周目 MAJOR-1）。
 * ここに構造的に同一な写しを置いていたので、`tsc` は**サーバ応答型とクライアント述語を
 * 結ばなかった** ―― 片方だけ変えてもコンパイルが通り、増分 2 で述語を「形が違えば拒否」へ
 * 厳しくした後は、サーバ側が 1 フィールドずらすだけで**自己特定退館が全滅**する
 * （画面は `unexpected` を出すだけで、テストは緑のまま）。写しは必ずズレる。
 */
export type { CheckoutSelfIdSummary } from './self-id';

/** 退館の自己特定手段。 */
export type CheckoutMethod = 'qr' | 'code';

/**
 * 読み取り（自己特定 resolve・在館一覧 GET）の**締切** (#1029)。
 *
 * 🔴 **これが無いと `busy` が永久に下りない。** `CheckoutFlow` の `busy` は `finally` でしか
 * false へ戻らないので、サーバが受け取ったまま何も返さない回線（Lambda のコールドスタート・
 * NAT の詰まり・テザリング）では、**退館の手段 3 つが全部 `disabled` のまま固まる**
 * ―― コード送信・QR 送信・在館一覧からの選択。逃げ道の「最初から」も `setBusy(false)` を
 * 呼ばないので、来訪者はリロード以外に出口を持たない。
 *
 * 値は `PLATFORM_READ_TIMEOUT_MS`（#968）と揃える。読み取りなので中断しても取り返しがつく。
 *
 * ⚠️ **「取り返しがつく」は resolve では厳密ではない**（独立レビュー 1 周目 残存リスク 2）。
 * コード経路の失敗は `src/lib/visit/checkout-credential.ts` がスロットルへ計上するので、
 * 中断が続けば `throttled` に達しうる。それでも**固まったままより良い**という判断で
 * 15 秒を選んでいる。ここを縮めると誤検知でスロットルを焚くので、下界を
 * `logic.test.ts` が縛る。
 */
export const CHECKOUT_READ_TIMEOUT_MS = 15_000;

/**
 * 退館確定（confirm）の**締切** (#1029)。
 *
 * 🔴 **read より長くとり、サーバの予算より長くする**（#968 が `read-response.ts` に
 * 明文化した理由をそのまま踏襲する）。web Lambda の `serverTimeoutSec` は 3 環境とも
 * **30 秒**（`infra/lib/config/environments.ts`）。クライアントを同じかそれ以下にすると
 * **サーバ自身の応答が必ずこちらの中断に負け**、「サーバ側で確実に完了しなかった」という
 * 知り得たはずの事実に到達できなくなる。5 秒の余裕を持たせて、サーバの返事を先に見る。
 *
 * 🔴 **e2e のために縮めないこと。** #826 で「しきい値を圧縮したら、本番の窓では起きない
 * 条件でしか再現しないテストになっていた」を踏んでいる。
 */
export const CHECKOUT_CONFIRM_TIMEOUT_MS = 35_000;

/**
 * 退館確定が**適用されたか分からない**ときの失敗理由 (#1029)。
 *
 * 🔴 **「失敗した」と言い切らないための専用の理由である。** 中断したのは**こちらの待ち**で
 * あって、サーバは退館を受理して監査に残しているかもしれない。既定の `network`
 * （「通信エラーが発生しました。もう一度お試しください。」）へ倒すと、**既に退館済みの
 * 来訪者に未完だと信じさせて**操作を繰り返させ、`already_checked_out` / `not_found` を
 * 踏ませることになる。成功を否定せず、有人導線へ繋ぐ（`docs/experience/README.md` 原則 5）。
 *
 * 🔴 **締切だけでなく 5xx もここへ入れる**（独立レビュー 1 周目 MAJOR-1）。
 * 本番の origin は `serverTimeoutSec` と同じ 30 秒で読み切りを打ち切るので、ハング時に
 * ブラウザへ**先に届くのは CloudFront の 504** であり、35 秒の締切はほとんど発火しない。
 * 5xx を既定の `network` に残すと、**この理由コードを足した意味が主経路で失われる**。
 * `src/components/admin/ui/save-outcome.ts` が #973 で同じ結論に達している ――
 * 「5xx は『拒否した』と同値ではない。LB の 502 / 504 も同型」。
 */
export const CHECKOUT_CONFIRM_UNKNOWN_REASON = 'confirm_unknown';

/**
 * 退館確定の**非 200** 応答を、来訪者にできることが変わる粒度へ写す (#1029)。
 *
 * - 4xx … サーバが要求を**見たうえで**断った。本文の理由をそのまま使う
 *   （`already_checked_out` / `not_found` / `expired` …）
 * - 5xx … 適用されたか**分からない**。断定しない語彙へ寄せる
 */
export function confirmFailureReason(status: number, reasonFromBody: string): string {
  return status >= 500 ? CHECKOUT_CONFIRM_UNKNOWN_REASON : reasonFromBody;
}

/**
 * 退館確定が失敗したとき、**自分が張った締切が切れていたか**で理由を分ける (#1029)。
 *
 * 🔴 **例外の `name` を見ない**（独立レビュー 1 周目 MINOR-2 / 残存リスク 1）。
 * 締切は相によって別の名前で投げる —— Chromium の実測では、ヘッダが来なければ
 * `TimeoutError`、ヘッダは 200 で **body が止まる**と `res.json()` が `AbortError`。
 * さらに **WebKit（実機の iPad Safari）で同じ名前を使う保証が無く、この環境には
 * webkit バイナリが無いので実測できない**。名前で分けると、別の名前を使うエンジンでは
 * 締切が黙って `network`（再試行だけを促す）へ落ちる ―― 画面にも痕跡が残らない。
 *
 * `signal.aborted` は**自分が張った締切そのもの**なので、エンジンに依らない。
 *
 * - `true`  … 締切が切れた。サーバは退館を受理しているかもしれない ⇒ 断定しない
 * - `false` … 接続そのものが失敗した（サーバへ**届いていない**）⇒ 再試行を促してよい
 *
 * 🔴 **両方向に害がある。** 締切側へ倒しすぎると再試行すれば済む来訪者を受付へ歩かせ、
 * `network` 側へ倒すと既に退館済みかもしれない来訪者に再試行を促す。`logic.test.ts` が
 * 両方を縛る。
 */
export function confirmFailureFromAbort(deadlineAborted: boolean): string {
  return deadlineAborted ? CHECKOUT_CONFIRM_UNKNOWN_REASON : 'network';
}

/**
 * API の失敗コード → 来訪者向け文言（`tr` で locale に応じて解決）。
 *
 * 退館の自己特定（#328）の resolve/confirm 由来コードも含めて写す:
 * - not_found:           退館 QR（token）が見つからない（token 経路。token は秘密なので区別可）。
 * - not_recognized:      退館コードまたは呼び出し先が確認できない（code 経路の**統一失敗**＝オラクル封じ）。
 * - already_checked_out: すでに退館済み（二重退館・誤操作からの復帰）。
 * - invalid:             入力が不正（コード形式不正・payload 不正）。
 * - expired:             退館コード/QR の有効期限切れ（#328）。
 * - throttled:           コード試行がウィンドウ内上限に達した（#328 列挙防止の一次防御）。
 * - network/その他:       通信エラー。
 */
export function CHECKOUT_FAILURE_MESSAGE(
  reason: string | undefined,
  tr: (key: MessageKey) => string,
): string {
  switch (reason) {
    case 'not_found':
      return tr('checkout.error.notFound');
    case 'not_recognized':
      return tr('checkout.error.notRecognized');
    /*
      🔴 **応答は届いたが、この画面が読める形ではなかった** (#1004 増分 2)。
      `invalid`（「受付番号を入力してください」）へ寄せてはいけない ―― (1) 来訪者の入力の
      せいにしている (2) いまの画面に「受付番号」という欄は無い（#328 で「退館コード」と
      「呼び出し先」に変わった）(3) 再試行では直らないのに有人導線が無い。
      `expired` / `throttled` と同じく**受付への導線を添える**（原則 5）。
    */
    case 'unexpected':
      return tr('checkout.error.unexpected');
    case 'already_checked_out':
      return tr('checkout.error.alreadyCheckedOut');
    case 'invalid':
      return tr('checkout.error.invalid');
    case 'expired':
      return tr('checkout.error.expired');
    case 'throttled':
      return tr('checkout.error.throttled');
    /*
      🔴 **読み取りの締切切れは「通信エラー」ではない**（独立レビュー 3 周目 MINOR-1）。
      回線は生きていて、こちらが 15 秒で打ち切っただけである。resolve は再試行が安全なので
      促してよいが、**通信のせいにはしない** —— staff に存在しない障害を疑わせる。
    */
    case 'timeout':
      return tr('checkout.error.timeout');
    // 🔴 成功を否定しない言い方（`CHECKOUT_CONFIRM_UNKNOWN_REASON` の doc を参照）。
    case CHECKOUT_CONFIRM_UNKNOWN_REASON:
      return tr('checkout.error.confirmUnknown');
    default:
      return tr('checkout.error.network');
  }
}
