/**
 * 受付状態と音声対話状態から、VRM 描画専用の behavior を純粋に導出する。
 *
 * 背景: issue #1084 / #1076。
 * Comu の「会話状態をアニメーション controller 群へ配る」思想は採用するが、
 * open-reception では `ReceptionState` / `VoiceKioskMode` が既に真実源である。
 * そのため本モジュールは状態を一切所有せず、既存状態から描画ヒントだけを導出する。
 *
 * 重要:
 * - 受付フローを進めない。
 * - 音声セッションを進めない。
 * - PII を持たない。
 * - LLM 出力を直接受け取らない。
 */
import type { AvatarState } from '@/domain/reception/ui-contract';
import type { VoiceKioskMode } from '@/domain/voice-session/kiosk-view';

export const AVATAR_BEHAVIOR_PHASES = ['ambient', 'listening', 'thinking', 'speaking'] as const;
export type AvatarBehaviorPhase = (typeof AVATAR_BEHAVIOR_PHASES)[number];

export type AvatarBehavior = Readonly<{
  /** 受付UX上の役割。`ReceptionState` → `AvatarState` の既存導出結果をそのまま保持する。 */
  baseState: AvatarState;
  /** VRM の微動・視線・呼吸等を調整するための一時的な会話局面。 */
  phase: AvatarBehaviorPhase;
  /** 既存 lip-sync / TTS wiring との整合確認に使える派生フラグ。 */
  speaking: boolean;
  /** 視線・微動を「相手へ集中」側へ寄せるための派生フラグ。 */
  listenFocus: boolean;
}>;

export type AvatarBehaviorInput = Readonly<{
  avatarState: AvatarState;
  voiceMode: VoiceKioskMode;
  /**
   * 発話確定後、TTS開始前の「応答準備中」が既存の turn/session 層から観測できる場合だけ true。
   * 独自タイマーや状態機械を本モジュールへ追加して推測してはならない。
   * `voiceMode=idle` のときだけ thinking へ昇格させる。
   */
  responsePending?: boolean;
}>;

/**
 * 描画 behavior を導出する。
 *
 * 優先順位:
 * 1. TTS 発話中 (`speaking`)
 * 2. ユーザー発話を聞いている / barge-in duck (`listening` / `ducked`)
 * 3. 確定済み応答待ち (`idle` + responsePending)
 * 4. それ以外 (`ambient`)
 *
 * `readback` / `fallback` / `unavailable` 等を勝手に speaking と解釈しない。
 * 実際の TTS 開始は `VoiceKioskMode=speaking` という既存の事実を優先する。
 */
export function deriveAvatarBehavior(input: AvatarBehaviorInput): AvatarBehavior {
  let phase: AvatarBehaviorPhase = 'ambient';

  if (input.voiceMode === 'speaking') {
    phase = 'speaking';
  } else if (input.voiceMode === 'listening' || input.voiceMode === 'ducked') {
    phase = 'listening';
  } else if (input.voiceMode === 'idle' && input.responsePending === true) {
    phase = 'thinking';
  }

  return {
    baseState: input.avatarState,
    phase,
    speaking: phase === 'speaking',
    listenFocus: phase === 'listening',
  };
}
