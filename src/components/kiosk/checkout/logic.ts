/**
 * 受付端末 退館フローの純ロジック (issue #102, increment 1)。
 *
 * 画面（CheckoutFlow）から副作用のない型・文言マッピングを切り出し、node 環境で検証する。
 * 文言には PII を含めない。
 */

/** 退館フローの画面状態。 */
export type CheckoutFlowState = 'input' | 'done';

/** 在館中サマリ（PII を含まない。受付番号と入館時刻のみ）。 */
export type PresentStaySummary = {
  stayId: string;
  checkedInAt: string;
};

/**
 * API の失敗コード → 来訪者向け文言。
 * - not_found:           受付番号が見つからない（誤入力・他拠点）。
 * - already_checked_out: すでに退館済み（二重退館・誤操作からの復帰）。
 * - invalid:             入力が不正。
 * - network/その他:       通信エラー。
 */
export function CHECKOUT_FAILURE_MESSAGE(reason: string | undefined): string {
  switch (reason) {
    case 'not_found':
      return '受付番号が見つかりませんでした。番号をご確認ください。';
    case 'already_checked_out':
      return 'この受付番号はすでに退館済みです。';
    case 'invalid':
      return '受付番号を入力してください。';
    default:
      return '通信エラーが発生しました。もう一度お試しください。';
  }
}
