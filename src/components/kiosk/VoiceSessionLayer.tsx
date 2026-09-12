/**
 * `VoiceSessionLayer` — Kiosk へ差し込む音声対話 UI の結線点 (issue #364 / #1077)。
 *
 * `KioskFlow` は `voiceSession` prop（`VoiceSessionFactory`）が与えられたときだけこのレイヤを
 * マウントする。未指定なら一切マウントされず、Kiosk は従来どおりタッチ専用で動作する。
 */
'use client';

import type { Locale } from '@/lib/i18n';
import type {
  OnCommittedUtterance,
  OnResolved,
  VoiceSessionFactory,
} from '@/lib/voice-session/kiosk-binding';
import type { ReceptionState } from '@/domain/reception/state';
import { useEffect, useRef } from 'react';
import { announcementPhrase, shouldAnnounce } from './voice-announcement';
import type { VoiceKioskState } from '@/domain/voice-session/kiosk-view';
import { useVoiceSession } from './useVoiceSession';
import { VoiceReadbackConfirm } from './VoiceReadbackConfirm';

export type VoiceSessionLayerProps = {
  factory: VoiceSessionFactory;
  locale: Locale;
  receptionState: ReceptionState;
  /** 旧target-only経路。natural conversationがclaimしない発話では従来どおり使う。 */
  onResolved?: OnResolved;
  /**
   * #1077 multi-slot会話。確定発話をKioskへ一時通知し、claimした場合は旧target-only解決を抑止する。
   * transcript はUI/メモリ内処理だけで、ログへ書かない。
   */
  onCommittedUtterance?: OnCommittedUtterance;
  /** 字幕と同じ意味の案内を端末から読み上げる。 */
  onAnnounce?: (text: string) => void;
};

export function VoiceSessionLayer({
  factory,
  locale,
  receptionState,
  onResolved,
  onCommittedUtterance,
  onAnnounce,
}: VoiceSessionLayerProps) {
  const { state, confirmYes, confirmNo } = useVoiceSession(
    factory,
    receptionState,
    onResolved,
    onCommittedUtterance,
  );

  /*
   * 局面へ入った瞬間に1度だけ読み上げる (#803)。覚えるのは文言ではなく局面。
   */
  const announcedRef = useRef<VoiceKioskState | null>(null);
  useEffect(() => {
    if (!shouldAnnounce(announcedRef.current, state)) return;
    announcedRef.current = state;
    const phrase = announcementPhrase(state, locale);
    if (phrase !== null) onAnnounce?.(phrase);
  }, [state, locale, onAnnounce]);

  return <VoiceReadbackConfirm state={state} locale={locale} onYes={confirmYes} onNo={confirmNo} />;
}
