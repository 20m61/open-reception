'use client';

/**
 * kiosk 待機画面の営業状態を SSR 初期値 + クライアント定期再取得のハイブリッドで供給する
 * React フック (issue #367 残)。純ロジックは `operating-status-poll.ts` に切り出し済みで、
 * ここは実物（`fetch` / `document` / `setInterval` / `setState`）への薄い配線だけを持つ。
 *
 * - 初期値はサーバ評価（`/kiosk` page.tsx）をそのまま採用 → 初回描画のチラつき無し。
 * - 一定間隔（`OPERATING_STATUS_POLL_INTERVAL_MS`）で `/api/kiosk/config` を再取得し、
 *   営業中→時間外（またはその逆）を待機画面へ反映する。
 * - 取得失敗・不正応答は直前値を保持（fail-open。閉店化しない）。連続失敗でもリトライし続ける。
 * - `document.hidden` の間はポーリングを停止（iPad の省電力・無駄リクエスト防止）。
 *   再表示（visibilitychange → visible）で即時 1 回取得し、離席復帰時の陳腐化を素早く解消する。
 * - unmount 時にインターバル解除 + 進行中 fetch を abort（リーク防止）。
 */
import { useEffect, useState } from 'react';
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import { createOperatingStatusPoller, sameOperatingStatus } from './operating-status-poll';

export function useOperatingStatus(
  initialStatus?: KioskOperatingStatus,
): KioskOperatingStatus | undefined {
  const [status, setStatus] = useState<KioskOperatingStatus | undefined>(initialStatus);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const poller = createOperatingStatusPoller({
      isHidden: () => document.hidden,
      onStatus: (next) =>
        setStatus((prev) => (sameOperatingStatus(prev, next) ? prev : next)),
    });
    poller.start();

    const onVisibility = () => {
      if (!document.hidden) void poller.poll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
    // 初期値はマウント時のみ採用する（force-dynamic の再訪はページ再マウントで反映される）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return status;
}
