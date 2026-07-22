/**
 * 音声対話セッション orchestrator の共通型 (issue #364 統合 — #369/#370/#371/#372 の合成層)。
 *
 * 位置づけ: `src/domain/voice-transport/` (#369) 等と同じ流儀 —— 純データ型のみを持つ。
 * I/O（各層クライアントの生成・接続・close）は `src/lib/voice-session/` が担う。
 *
 * どの層（transport/stt/tts/turn）の障害でも、Kiosk 側は **同じ形のイベントを 1 種類だけ**
 * 購読すればタッチ受付へ切り替えられる（issue #364 完了条件「音声基盤停止時もタッチ受付を
 * 完走できる」）。各層は既にそれぞれの `*FallbackRequired` イベント/エラーコードを持つ
 * （`voice-transport/fallback.ts` の `VoiceTransportFallbackEvent`、`voice-stt/fallback.ts` の
 * `VoiceSttFallbackEvent`、`voice-tts/fallback.ts` の `TtsFailureReason`、`voice-turn/eval-bridge.ts`
 * の `VoiceTurnErrorCode`）—— ここではそれらを **正規化するだけ**で、各層固有の意味は
 * `reason`（元の値をそのまま文字列として保持）に残す。
 */

export const VOICE_SESSION_FALLBACK_SOURCES = ['transport', 'stt', 'tts', 'turn'] as const;

/** どの層で発生した障害か。 */
export type VoiceSessionFallbackSource = (typeof VOICE_SESSION_FALLBACK_SOURCES)[number];

/**
 * 4 層のいずれかの障害を正規化した単一のフォールバックイベント。Kiosk 側はこの 1 種類だけを
 * 購読すればよい（`source`/`reason` は診断用の内訳であり、切替の判断自体には使わない）。
 */
export type VoiceSessionFallbackEvent = {
  type: 'voiceSessionFallbackRequired';
  source: VoiceSessionFallbackSource;
  /** 元の層が持つ理由コードをそのまま文字列として保持する（列挙可能な短い識別子のみ）。 */
  reason: string;
  /** セッション開始からの相対 ms（#365 の評価イベントと同じ単一時計源）。 */
  t: number;
};

/** VRM への中立な状態遷移指示。`src/domain/voice-turn/barge-in-controller.ts` の語彙を再輸出する。 */
export type VoiceSessionVrmState = 'speaking' | 'listening';
