import { KioskFlow } from '@/components/kiosk/KioskFlow';

/**
 * 受付端末のエントリ。状態遷移モデル (issue #10) に沿って
 * 待機 → 目的 → 担当者 → 入力 → 確認 → 呼び出し → 結果 を表示する (issue #11–#15)。
 */
export default function KioskHomePage() {
  return <KioskFlow />;
}
