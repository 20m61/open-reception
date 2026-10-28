/**
 * `VoiceSessionLayer` — Kiosk へ差し込む音声対話 UI の結線点 (issue #364 kiosk 配線)。
 *
 * `KioskFlow` は `voiceSession` prop（`VoiceSessionFactory`）が与えられたときだけこのレイヤを
 * マウントする。未指定なら一切マウントされず、Kiosk は従来どおりタッチ専用で動作する（無変更）。
 * レイヤは `useVoiceSession` で状態を購読し、表示専用の `VoiceReadbackConfirm` へ橋渡しするだけ。
 */
'use client';

import type { Locale } from '@/lib/i18n';
import type {
  OnResolved,
  OnVisitorNameConfirmed,
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
   * 復唱への「はい」で確定した来訪者の氏名を受け取る (ADR 0011、#1290)。安定参照を渡すこと。
   * `KioskFlow` はこれを `SUBMIT_VISITOR_INFO` へだけ写す。
   */
  onVisitorNameConfirmed?: OnVisitorNameConfirmed;
  /**
   * `inputVisitorInfo` に居るときだけ非 null。`eligible` は音声で氏名を聞いてよいか、`noticeText` は
   * 聞く前に読み上げる通知（固定の前置き＋要約）。
   */
  visitorNameVoice?: { eligible: boolean; noticeText: string } | null;
  /** 通知を読み上げ、最後まで読み終えたかを返す（`speakUntilEnd`）。 */
  speakNotice?: (text: string) => Promise<boolean>;
  /** この画面でキーボード入力が始まったら増える。増えたら聞き取りと復唱を止める（§3-c）。 */
  typingSignal?: number;
  /** 言い直しが尽きた（キーボードへの案内）。入力欄へフォーカスを移す（§3-c）。 */
  onVisitorNameKeyboard?: () => void;
};

export function VoiceSessionLayer({
  factory,
  locale,
  receptionState,
  onResolved,
  onAnnounce,
  onVisitorNameConfirmed,
  visitorNameVoice = null,
  speakNotice,
  typingSignal = 0,
  onVisitorNameKeyboard,
}: VoiceSessionLayerProps) {
  const { state, confirmYes, confirmNo, visitorName } = useVoiceSession(
    factory,
    receptionState,
    onResolved,
    onVisitorNameConfirmed,
  );

  /*
   * 氏名の聞き取り (ADR 0011 §2、#1290)。画面に入ったら、聞いてよいかを知らせ、聞いてよければ
   * 通知を読み上げ、**最後まで読み終えたときだけ**聞き取りを始めさせる。
   *
   * 受付局面の通知（`useVoiceSession` の effect）が先に走る（宣言順）ので、結線はこの画面に
   * 居ることを知ったうえで `enter` を受ける。画面を出たときの後始末は結線が局面の通知で行う。
   */
  const eligible = visitorNameVoice?.eligible ?? null;
  const noticeText = visitorNameVoice?.noticeText ?? '';
  useEffect(() => {
    if (eligible === null) return;
    visitorName({ type: 'enter', eligible });
    if (!eligible || speakNotice === undefined) {
      if (eligible) visitorName({ type: 'noticeFinished', ok: false });
      return;
    }
    let cancelled = false;
    void speakNotice(noticeText).then((ok) => {
      if (!cancelled) visitorName({ type: 'noticeFinished', ok });
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, noticeText, speakNotice, visitorName]);

  useEffect(() => {
    if (typingSignal > 0) visitorName({ type: 'typing' });
  }, [typingSignal, visitorName]);

  const keyboardGuided = state.mode === 'keyboardGuide';
  useEffect(() => {
    if (keyboardGuided) onVisitorNameKeyboard?.();
  }, [keyboardGuided, onVisitorNameKeyboard]);

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
