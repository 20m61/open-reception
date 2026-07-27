/**
 * 呼び出し失敗の理由と、来訪者へ出す文言の対応 (issue #422 / 体験設計 J-OR-05)。
 *
 * これまで**通信断もサーバエラーも想定外応答も同じ `CALL_FAILED`** に潰れており、来訪者には
 * 一律で「呼び出しに失敗しました。別の方法でお呼びすることもできます。」と出ていた。通信が
 * 切れているだけの来訪者に「呼び出しは行われたが失敗した」と読める案内を出すのは、
 * 体験設計の原則「失敗理由を来訪者の責任として表現しない」「システム状態を沈黙させない」
 * （`docs/experience/README.md`）に反する。
 *
 * **状態は増やさない。** `failed` のままで、`why` だけを添えて文言を選ぶ。README の例外状態
 * `network_degraded` と `contact_failed` の区別は、状態の分岐ではなく**同じ状態の中の説明**で
 * 満たせる（区別のために遷移表を増やすと、逃げ道・タイムアウト・戻るの組み合わせが倍になる）。
 *
 * **サーバ側からは観測できない**ことに注意。通信断で失敗した受付は、そもそもサーバへ到達して
 * いないので受付ログに残らない。この区別は端末の画面表示のためだけに存在する。
 */
import type { MessageKey } from '@/lib/i18n';

export const CALL_FAILURE_REASONS = ['network', 'server'] as const;

/**
 * - `network` … 端末からサーバへ到達できなかった（fetch が例外）。復旧すれば同じ操作で通る。
 * - `server`  … 到達はしたが呼び出しを完了できなかった（HTTP エラー・想定外の応答）。
 */
export type CallFailureReason = (typeof CALL_FAILURE_REASONS)[number];

/**
 * 失敗理由に対応する本文の i18n キー。理由が不明（旧経路・未設定）なら従来の文言へ倒す
 * （文言が増えるだけで、既存の挙動は変わらない）。
 */
export function failedMessageKeyFor(reason: CallFailureReason | undefined): MessageKey {
  return reason === 'network' ? 'reception.failedNetworkBody' : 'reception.failedBody';
}

/**
 * 代替導線（代表窓口へ）を主 CTA として出すか。
 *
 * **通信断では出さない。** 代替導線の文言は「代表窓口にお繋ぎします。受付スタッフが対応
 * いたしますので、しばらくお待ちください」で、**システムが取り次ぐという約束**になっている。
 * 通信が切れている端末はその約束を果たせないため、押させると来訪者を待たせるだけになる。
 * 逃げ道バー（最初に戻る）は常時可視なので行き止まりにはならない。
 */
export function shouldOfferAlternativeContact(reason: CallFailureReason | undefined): boolean {
  return reason !== 'network';
}
