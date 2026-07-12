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

/** 退館の自己特定サマリ（確認ステップ表示用・非 PII）。 */
export type CheckoutSelfIdSummary = {
  checkedInAt: string;
  targetLabel: string;
  purpose: string;
};

/** 退館の自己特定手段。 */
export type CheckoutMethod = 'qr' | 'code';

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
    case 'already_checked_out':
      return tr('checkout.error.alreadyCheckedOut');
    case 'invalid':
      return tr('checkout.error.invalid');
    case 'expired':
      return tr('checkout.error.expired');
    case 'throttled':
      return tr('checkout.error.throttled');
    default:
      return tr('checkout.error.network');
  }
}
