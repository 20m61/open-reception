/**
 * Kiosk 側の音声対話 UI 状態機械 (issue #364 kiosk 配線 + #361 音声復唱 UI)。
 *
 * 位置づけ: `src/lib/voice-session/orchestrator.ts`（各層 glue）とは別レイヤ。orchestrator は
 * 音声パイプライン（transport/stt/tts/turn）の駆動に徹し、ビジネス/UI 状態は持たない。本モジュールは
 * その orchestrator（あるいはデモ/テスト用の synthetic driver）から届くイベントを、**Kiosk が字幕・
 * 復唱確認・インジケータへ描画するための最小 UI 状態**へ純粋に写像する reducer を提供する。
 *
 * 設計原則（`ui-contract.ts` の #361 原則を継承）:
 *  - 純関数のみ。I/O・時計・React 依存を持たない（テスト容易性と demo-studio 再現性のため）。
 *  - PII を状態へ持ち込まない —— `readbackName` は「呼び出したい担当者/部門の表示名（組織が管理する
 *    既知の辞書値、`src/domain/staff`）」であり来訪者本人の氏名等ではない。いずれにせよ本状態は
 *    画面表示用の一時値で、監査ログ・評価イベントへは出力しない（`.claude/rules/pii-secret-minimization.md`）。
 *  - タッチ受付の不変条件を壊さない: `fallback` へ落ちたら音声側は deactivate まで戻らず、Kiosk は
 *    既存タッチ UI で受付を完走できる（issue #364 完了条件「音声基盤停止時もタッチ受付を完走できる」）。
 */
import type { VoiceSessionFallbackSource } from './types';
import type { SttEntityConfirmationReason } from '@/domain/voice-stt/entity-resolver';

/**
 * 音声対話 UI の局面。
 *  - inactive: 音声モード未活性（注入なし時の既定。字幕/復唱 UI を一切出さない）。
 *  - idle:     活性・待機（次の発話・発話ターンの区切り）。
 *  - listening: ユーザー発話を取り込み中（字幕「お話しください」＋リスニングインジケータ）。
 *  - readback: 復唱確認（「◯◯様ですね？」＋はい/いいえ）。低信頼(#370)の確認遷移の受け皿。
 *  - speaking: TTS 発話中（アバター口パク結線があればそこへ、字幕「ご案内しています」）。
 *  - ducked:  barge-in で TTS を duck しユーザー発話へ道を譲った局面（字幕「どうぞ」）。
 *  - fallback: 音声基盤障害でタッチへ縮退した局面（案内字幕を出しタッチ UI へ委ねる）。
 */
export const VOICE_KIOSK_MODES = [
  'inactive',
  'idle',
  'listening',
  'readback',
  'speaking',
  'ducked',
  'fallback',
] as const;

export type VoiceKioskMode = (typeof VOICE_KIOSK_MODES)[number];

export type VoiceKioskState = {
  mode: VoiceKioskMode;
  /** 復唱対象の表示名（担当者/部門名。UI 一時表示のみ・ログ/eval へ出さない）。 */
  readbackName?: string;
  /** 復唱を促した低信頼の別（表示ニュアンス切替に使う。#370 の確認理由をそのまま持つ）。 */
  readbackReason?: SttEntityConfirmationReason;
  /** 直近フォールバック源（診断用。PII なし）。 */
  fallbackSource?: VoiceSessionFallbackSource;
};

export type VoiceKioskEvent =
  /** 音声モードを活性化する（注入 prop が有効なとき Kiosk が発火）。 */
  | { type: 'activate' }
  /** 音声モードを解除する（注入解除・アンマウント・セッション終了）。どの局面からも inactive へ。 */
  | { type: 'deactivate' }
  /** ユーザー発話の取り込みを開始した。 */
  | { type: 'listenStart' }
  /** 発話が確定し、高信頼で自動採用された（復唱を挟まず次ターンへ）。 */
  | { type: 'heardAccepted' }
  /** 発話が確定したが低信頼のため復唱確認が必要（#370 decideEntityConfirmation）。 */
  | { type: 'heardNeedsConfirmation'; displayName: string; reason: SttEntityConfirmationReason }
  /** 復唱確認に「はい」（タッチでも音声でも同じ入口）。 */
  | { type: 'confirmYes' }
  /** 復唱確認に「いいえ」（聞き直しへ）。 */
  | { type: 'confirmNo' }
  /** TTS 発話が始まった。 */
  | { type: 'speakStart' }
  /** TTS 発話が終わった（最後まで再生 or resume 後の自然終了）。 */
  | { type: 'speakEnd' }
  /** TTS 発話中のユーザー発話で barge-in（duck）が発生した。 */
  | { type: 'bargeInDuck' }
  /** いずれかの層の障害でタッチへ縮退する（正規化済みの単一フォールバック）。 */
  | { type: 'fallbackRequired'; source: VoiceSessionFallbackSource };

/** 初期状態。音声モードは未活性（注入なし時の Kiosk と同一 = 退行なし）。 */
export function initialVoiceKioskState(): VoiceKioskState {
  return { mode: 'inactive' };
}

/**
 * 音声対話 UI 状態機械。純関数・不変更新。
 *
 * 不変条件:
 *  - inactive では activate 以外を無視する（音声モード未注入時の完全な無変更動作の担保）。
 *  - fallback は deactivate 以外では抜けない（タッチ縮退を維持し、受付をタッチで完走させる）。
 */
export function voiceKioskReducer(state: VoiceKioskState, event: VoiceKioskEvent): VoiceKioskState {
  // deactivate はどの局面からでも最優先で未活性へ戻す。
  if (event.type === 'deactivate') return initialVoiceKioskState();

  // 未活性のときは activate 以外を無視（退行防止）。
  if (state.mode === 'inactive') {
    return event.type === 'activate' ? { mode: 'idle' } : state;
  }

  // 縮退（fallback）中は deactivate 以外の音声イベントを無視してタッチへ委ねたままにする。
  if (state.mode === 'fallback') {
    return state;
  }

  switch (event.type) {
    case 'activate':
      // 既に活性。無変更（idempotent）。
      return state;

    case 'fallbackRequired':
      return { mode: 'fallback', fallbackSource: event.source };

    case 'listenStart':
      return { mode: 'listening' };

    case 'heardAccepted':
      // 高信頼採用 → 次ターンのため待機へ。
      return { mode: 'idle' };

    case 'heardNeedsConfirmation':
      return { mode: 'readback', readbackName: event.displayName, readbackReason: event.reason };

    case 'confirmYes':
      // 復唱を確定 → 次ターンのため待機へ（復唱情報はクリア）。
      return { mode: 'idle' };

    case 'confirmNo':
      // 聞き直しへ。
      return { mode: 'listening' };

    case 'speakStart':
      return { mode: 'speaking' };

    case 'speakEnd':
      // 発話終了（speaking からも ducked からも）→ 待機へ収束。
      return { mode: 'idle' };

    case 'bargeInDuck':
      // TTS 発話中の割込のみ意味を持つ。それ以外の局面では無視。
      return state.mode === 'speaking' ? { mode: 'ducked' } : state;

    default: {
      // 網羅性チェック（新イベント追加時にコンパイルで気付く）。
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** 字幕/インジケータへ描画する意味論キー（i18n MessageKey と一致）。表示不要な局面は null。 */
export type VoiceKioskCaptionKey =
  | 'voice.caption.listening'
  | 'voice.caption.speaking'
  | 'voice.caption.ducked'
  | 'voice.readback.confirmTarget'
  | 'voice.fallback.touchNotice';

/**
 * 現在の局面に対応する字幕キーを返す（PII を含まない意味論キーのみ）。idle/inactive は字幕なし。
 * component 層がこのキーを `t()` で locale 解決して描画する（domain → component へ依存しない）。
 */
export function captionKeyFor(state: Pick<VoiceKioskState, 'mode'>): VoiceKioskCaptionKey | null {
  switch (state.mode) {
    case 'listening':
      return 'voice.caption.listening';
    case 'speaking':
      return 'voice.caption.speaking';
    case 'ducked':
      return 'voice.caption.ducked';
    case 'readback':
      return 'voice.readback.confirmTarget';
    case 'fallback':
      return 'voice.fallback.touchNotice';
    case 'idle':
    case 'inactive':
      return null;
    default: {
      const _exhaustive: never = state.mode;
      return _exhaustive;
    }
  }
}
