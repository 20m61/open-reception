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
import type { VoiceSessionFactory } from '@/lib/voice-session/kiosk-binding';
import type { VoiceKioskState } from '@/domain/voice-session/kiosk-view';

export type UseVoiceSessionResult = {
  state: VoiceKioskState;
  confirmYes: () => void;
  confirmNo: () => void;
};

export function useVoiceSession(factory: VoiceSessionFactory): UseVoiceSessionResult {
  const store = useMemo(() => new VoiceKioskStore(factory), [factory]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    store.start();
    return () => store.close();
  }, [store]);

  return { state, confirmYes: store.confirmYes, confirmNo: store.confirmNo };
}
