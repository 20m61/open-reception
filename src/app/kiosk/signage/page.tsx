import { SignageDisplay } from '@/components/kiosk/signage/SignageDisplay';

export const dynamic = 'force-dynamic';

/**
 * 受付端末の待機中サイネージ（スタンドアロン待機画面）(issue #101)。
 *
 * KioskFlow へは組み込まず、独立した待機ルートとして提供する。タップ/クリック/キー操作で
 * /kiosk へ遷移＝受付復帰する。presence 検知での自動遷移配線は次増分。
 */
export default function KioskSignagePage() {
  return <SignageDisplay />;
}
