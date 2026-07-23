/**
 * `useVoiceSession` — `VoiceSessionFactory` を React へ束ねる薄いフック (issue #364 kiosk 配線)。
 *
 * ロジックは `VoiceKioskStore`（React 非依存・単体テスト済み）に閉じ、ここは `useSyncExternalStore`
 * での購読とライフサイクル（start/close）だけを担う。状態機械・synthetic 駆動・orchestrator 写像は
 * すべて `src/lib/voice-session/` 側にあるため、フックは差し替え可能な glue に徹する。
 */
'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { VoiceKioskStore } from '@/lib/voice-session/kiosk-store';
import type { OnResolved, VoiceSessionFactory, VoiceSessionHooks } from '@/lib/voice-session/kiosk-binding';
import type { VoiceKioskState } from '@/domain/voice-session/kiosk-view';
import type { ReceptionState } from '@/domain/reception/state';

export type UseVoiceSessionResult = {
  state: VoiceKioskState;
  confirmYes: () => void;
  confirmNo: () => void;
};

/**
 * @param receptionState 現在の受付局面 (issue #364/#363/#361 第9wave ゼロタッチ自動化)。値が変わる
 *   たびに `store.notifyReceptionState` へ中継する（selectingTarget 到達での自動再生トリガに使う。
 *   `VoiceSessionController.notifyReceptionState` 未実装の controller には no-op）。
 * @param onResolved 音声で確定した相手候補を受け取る実結線点（KioskFlow が SELECT_TARGET へ渡す）。
 *   **安定参照を渡すこと**（呼び出し側で `useCallback` 等）。この identity が変わるとストアを作り直し、
 *   音声セッションが start/close で再起動する。KioskFlow は `dispatch`（useReducer 由来で安定）だけに
 *   依存した安定コールバックを渡すため、通常は再生成されない。
 */
export function useVoiceSession(
  factory: VoiceSessionFactory,
  receptionState: ReceptionState,
  onResolved?: OnResolved,
): UseVoiceSessionResult {
  const hooks = useMemo<VoiceSessionHooks>(() => ({ onResolved }), [onResolved]);
  const store = useMemo(() => new VoiceKioskStore(factory, hooks), [factory, hooks]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    store.start();
    return () => store.close();
  }, [store]);

  // selectingTarget 到達（および BACK 等での再到達）を controller へ通知する。start-effect の
  // 後に走る（宣言順）が、start() 自体は同期タイマーを積まないため順序に依存しない。
  useEffect(() => {
    store.notifyReceptionState(receptionState);
  }, [store, receptionState]);

  return { state, confirmYes: store.confirmYes, confirmNo: store.confirmNo };
}
