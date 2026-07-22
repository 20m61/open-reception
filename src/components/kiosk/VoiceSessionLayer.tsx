/**
 * `VoiceSessionLayer` — Kiosk へ差し込む音声対話 UI の結線点 (issue #364 kiosk 配線)。
 *
 * `KioskFlow` は `voiceSession` prop（`VoiceSessionFactory`）が与えられたときだけこのレイヤを
 * マウントする。未指定なら一切マウントされず、Kiosk は従来どおりタッチ専用で動作する（無変更）。
 * レイヤは `useVoiceSession` で状態を購読し、表示専用の `VoiceReadbackConfirm` へ橋渡しするだけ。
 */
'use client';

import type { Locale } from '@/lib/i18n';
import type { VoiceSessionFactory } from '@/lib/voice-session/kiosk-binding';
import { useVoiceSession } from './useVoiceSession';
import { VoiceReadbackConfirm } from './VoiceReadbackConfirm';

export type VoiceSessionLayerProps = {
  factory: VoiceSessionFactory;
  locale: Locale;
};

export function VoiceSessionLayer({ factory, locale }: VoiceSessionLayerProps) {
  const { state, confirmYes, confirmNo } = useVoiceSession(factory);
  return <VoiceReadbackConfirm state={state} locale={locale} onYes={confirmYes} onNo={confirmNo} />;
}
