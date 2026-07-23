/**
 * `VoiceSessionLayer` — Kiosk へ差し込む音声対話 UI の結線点 (issue #364 kiosk 配線)。
 *
 * `KioskFlow` は `voiceSession` prop（`VoiceSessionFactory`）が与えられたときだけこのレイヤを
 * マウントする。未指定なら一切マウントされず、Kiosk は従来どおりタッチ専用で動作する（無変更）。
 * レイヤは `useVoiceSession` で状態を購読し、表示専用の `VoiceReadbackConfirm` へ橋渡しするだけ。
 */
'use client';

import type { Locale } from '@/lib/i18n';
import type { OnResolved, VoiceSessionFactory } from '@/lib/voice-session/kiosk-binding';
import type { ReceptionState } from '@/domain/reception/state';
import { useVoiceSession } from './useVoiceSession';
import { VoiceReadbackConfirm } from './VoiceReadbackConfirm';

export type VoiceSessionLayerProps = {
  factory: VoiceSessionFactory;
  locale: Locale;
  /**
   * 現在の受付局面 (issue #364/#363/#361 第9wave ゼロタッチ自動化)。KioskFlow の `data.state` を
   * そのまま渡す。voiceSession は reception 状態機械を直接観測できないため、この prop が唯一の
   * 観測経路になる（`useVoiceSession` → `VoiceKioskStore.notifyReceptionState` → controller の
   * 任意 hook。未実装の controller には no-op で実 orchestrator 経路には影響しない）。
   */
  receptionState: ReceptionState;
  /**
   * 音声で確定した相手候補を受け取る実結線点 (issue #364)。KioskFlow がこれを
   * `SELECT_TARGET` の dispatch へ橋渡しし、相手選択を実際に進める。未指定なら音声 UI は
   * 表示するが選択は進めない（表示専用）。
   */
  onResolved?: OnResolved;
};

export function VoiceSessionLayer({ factory, locale, receptionState, onResolved }: VoiceSessionLayerProps) {
  const { state, confirmYes, confirmNo } = useVoiceSession(factory, receptionState, onResolved);
  return <VoiceReadbackConfirm state={state} locale={locale} onYes={confirmYes} onNo={confirmNo} />;
}
