/**
 * `useVoiceSession` — `VoiceSessionFactory` を React へ束ねる薄いフック (issue #364/#1077)。
 *
 * ロジックは `VoiceKioskStore`（React 非依存・単体テスト済み）に閉じ、ここは `useSyncExternalStore`
 * での購読とライフサイクル（start/close）だけを担う。状態機械・synthetic 駆動・orchestrator 写像は
 * すべて `src/lib/voice-session/` 側にあるため、フックは差し替え可能な glue に徹する。
 */
'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { VoiceKioskStore } from '@/lib/voice-session/kiosk-store';
import type {
  OnCommittedUtterance,
  OnResolved,
  VoiceSessionFactory,
  VoiceSessionHooks,
} from '@/lib/voice-session/kiosk-binding';
import type { VoiceKioskState } from '@/domain/voice-session/kiosk-view';
import type { ReceptionState } from '@/domain/reception/state';

export type UseVoiceSessionResult = {
  state: VoiceKioskState;
  confirmYes: () => void;
  confirmNo: () => void;
};

/**
 * `onResolved` / `onCommittedUtterance` は**安定参照を渡すこと**。
 * hook object の identity が変わると VoiceKioskStore を作り直し、音声セッションが start/close で
 * 再起動する。KioskFlow は latest data/directory を ref から読む安定callbackを渡す。
 */
export function useVoiceSession(
  factory: VoiceSessionFactory,
  receptionState: ReceptionState,
  onResolved?: OnResolved,
  onCommittedUtterance?: OnCommittedUtterance,
): UseVoiceSessionResult {
  const hooks = useMemo<VoiceSessionHooks>(
    () => ({ onResolved, onCommittedUtterance }),
    [onResolved, onCommittedUtterance],
  );
  const store = useMemo(() => new VoiceKioskStore(factory, hooks), [factory, hooks]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    store.start();
    return () => store.close();
  }, [store]);

  useEffect(() => {
    store.notifyReceptionState(receptionState);
  }, [store, receptionState]);

  return { state, confirmYes: store.confirmYes, confirmNo: store.confirmNo };
}
