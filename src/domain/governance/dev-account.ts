/**
 * dev の AWS アカウント ID（#1238）。
 *
 * **リポジトリの中で本物の値を持つのは、この module だけにする。** コード（broker stack・
 * preflight・carve-out パターン・negative test・短命 credential の発行スクリプト）はここから読む。
 * 文書とコメントは `<DEV_ACCOUNT_ID>` と書き、テストはダミー（`111122223333`）を使う。
 * 本物の設定と一致しなければ意味を失うテストだけが、ここを import する。
 *
 * 例外: `scripts/aws-policies/*.json`（owner が手で適用する IAM policy）は、まだ本物の値を
 * 直接持つ（2026-10-27 の owner 判断で見送り）。一致はテストが縛る。
 *
 * アカウント ID は AWS 上の秘密ではない。目的は、公開リポジトリの目に付く場所を減らすことで、
 * 履歴からは引き続き読める（履歴は書き換えない）。
 *
 * 🔴 書式を変えない。短命 credential の発行スクリプト（bash）は、この行を
 * `export const DEV_ACCOUNT_ID = '<12 桁>';` の形として読む。
 */
export const DEV_ACCOUNT_ID = '822063948773';
