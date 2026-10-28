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
import { useEffect, useRef } from 'react';
import { announcementPhrase, shouldAnnounce } from './voice-announcement';
import type { VoiceKioskMode, VoiceKioskState } from '@/domain/voice-session/kiosk-view';
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
  /**
   * 端末に声で言わせる (#803)。`KioskFlow` が `speak()` を差し込む。
   *
   * 未指定なら字幕だけになる（従来動作）。**字幕と同じ文言**を渡す —— 表示と読み上げが
   * 食い違うと、聞いた内容と読んだ内容のどちらを信じるかを来訪者に選ばせることになる。
   */
  onAnnounce?: (text: string) => void;
  /**
   * 音声 UI の現在局面を描画側へ伝える観測口 (#1095)。渡すのは `VoiceKioskMode` だけで、
   * interim text / readback name 等の PII を含みうる値は境界を越えない。これは状態遷移の命令では
   * なく observation のみで、voice / reception reducer の所有権は変えない。
   */
  onModeChange?: (mode: VoiceKioskMode) => void;
};

export function VoiceSessionLayer({
  factory,
  locale,
  receptionState,
  onResolved,
  onAnnounce,
  onModeChange,
}: VoiceSessionLayerProps) {
  const { state, confirmYes, confirmNo } = useVoiceSession(factory, receptionState, onResolved);

  // AvatarBehavior へ渡すのは mode だけ。readbackName / interimText などは外へ出さない (#1095)。
  useEffect(() => {
    onModeChange?.(state.mode);
  }, [state.mode, onModeChange]);
  // voiceSession 注入が外れた/画面を離れた瞬間に観測値を必ず inactive へ戻す。
  // KioskFlow 側へ reset 用の第2 effect を増やさず、VoiceSessionLayer の生存期間と観測値を一致させる。
  useEffect(() => () => onModeChange?.('inactive'), [onModeChange]);

  /*
   * 局面へ**入った瞬間に 1 度だけ**読み上げる (#803)。判定は純関数へ出してある ——
   * ここ（effect の中）は node 環境で回せないので、埋めると縛れなくなる。
   *
   * 覚えるのは**文言ではなく局面**。同じ名前で再入したときに黙らせないため（`shouldAnnounce`）。
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
