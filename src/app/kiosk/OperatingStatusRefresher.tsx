'use client';

/**
 * `/kiosk` の薄いクライアントラッパ (issue #367 残)。
 *
 * サーバ側で評価した営業状態（`initialStatus`）を初期値に採り、`useOperatingStatus` で
 * 一定間隔の再取得を重ね、最新の `operatingStatus` を `KioskFlow` へ渡す。
 * `KioskFlow` は prop 変化で再レンダーし、`resolveKioskMode` が idle（待機）中のみ
 * `out_of_hours` へ差し替えるため、受付進行中の来訪者を放り出さずに待機画面だけが
 * 営業中↔時間外へ自動で切り替わる。
 *
 * `src/components/kiosk/**`（別トラック占有）は無改変: 既存の `operatingStatus` 受け口を
 * そのまま使うだけ。
 */
import { KioskFlow } from '@/components/kiosk/KioskFlow';
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import { useOperatingStatus } from '@/lib/kiosk/use-operating-status';

export function OperatingStatusRefresher({
  initialStatus,
}: {
  initialStatus?: KioskOperatingStatus;
}) {
  const operatingStatus = useOperatingStatus(initialStatus);
  return <KioskFlow operatingStatus={operatingStatus} />;
}
