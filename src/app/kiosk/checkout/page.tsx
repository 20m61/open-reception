import { CheckoutFlow } from '@/components/kiosk/checkout/CheckoutFlow';

/**
 * 受付端末の退館チェックアウト（スタンドアロン導線） (issue #102)。
 *
 * 通常の受付フロー（KioskFlow）には組み込まず、退館専用のルートとして提供する。
 * 受付番号 or 在館一覧から退館を確定する。完了後は個人情報を残さない。
 */
export default function KioskCheckoutPage() {
  return <CheckoutFlow />;
}
