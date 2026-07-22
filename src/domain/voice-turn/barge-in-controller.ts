/**
 * barge-in オーケストレーション (issue #372)。
 *
 * ```text
 * BOT_SPEAKING → near-end VAD → TTS duck → 150〜250msの継続を確認
 *   → backchannel / correction / noise分類
 *   → true interruptionなら再生停止・キュー破棄
 *   → 実際に再生済みの地点まで会話履歴を切り詰める（history-truncation.ts）
 *   → VRMをlisteningへ遷移
 * ```
 *
 * `near-end-classifier.ts` の純粋な分類関数を、状態を持つ純 reducer として駆動する。
 * I/O（実 duck ゲイン制御・実 TTS 停止 API 呼び出し）は持たない —— `TtsBargeInPort` を実装する
 * 呼び出し側（`src/lib/voice-turn/` 想定、次周回）が副作用を実行する。
 *
 * #371 (`src/domain/voice-tts/types.ts` の `TtsPlaybackController`) との接続点:
 * `TtsBargeInPort.stopPlayback` / `discardQueuedAudio` は #371 の `TtsPlaybackController` と
 * 同名・同シグネチャ（`utteranceId: string`）にしてあり、実装（`playback-controller.ts`）を
 * そのまま差し込める。`duck`/`resume` は第 5 wave 時点では #372 が新たに要求する能力で #371
 * 側に無かったが、第 6 wave で `TtsPlaybackControllerImpl`（`src/lib/voice-tts/
 * playback-controller.ts`）へ委譲メソッドとして追加し、`TtsBargeInPort` をそのまま実装できる
 * ようにした（`src/lib/voice-session/orchestrator.ts` が実際の配線例）。
 */
import { classifyNearEnd, shouldStopPlayback, type NearEndClassification, type NearEndClassifierConfig, type NearEndSignal } from './near-end-classifier';

/** #371 `TtsPlaybackController` と接続可能な最小 port（`stopPlayback`/`discardQueuedAudio` の形を共有）。 */
export interface TtsBargeInPort {
  /** 再生音量を下げて発話の継続を見極める間、キャラクターの声を聞き取りやすくする。 */
  duck(utteranceId: string): void;
  /** 誤検出/相づち/エコー/環境音と判定できたら通常音量へ戻す。 */
  resume(utteranceId: string): void;
  stopPlayback(utteranceId: string): void;
  discardQueuedAudio(utteranceId: string): void;
}

/** VRM への中立な状態遷移指示（`src/components/kiosk/` の実配線は次周回）。 */
export type VrmReactionState = 'speaking' | 'listening';

export const BARGE_IN_PHASES = ['idle', 'ducked', 'stopped'] as const;
export type BargeInPhase = (typeof BARGE_IN_PHASES)[number];

export type BargeInControllerState = {
  phase: BargeInPhase;
  /** 現在評価中の utteranceId（ducked 中のみ意味を持つ）。 */
  utteranceId: string | null;
};

export function initialBargeInControllerState(): BargeInControllerState {
  return { phase: 'idle', utteranceId: null };
}

export type BargeInAction =
  | { type: 'duck'; utteranceId: string }
  | { type: 'resume'; utteranceId: string; classification: NearEndClassification }
  | { type: 'stop_and_discard'; utteranceId: string; vrmState: VrmReactionState }
  | { type: 'await' } // pending。まだ判定できないので ducked のまま待つ。
  | { type: 'noop' };

/** 近端 onset を検出した瞬間（分類前）。まず duck する。 */
export function onNearEndOnset(state: BargeInControllerState, utteranceId: string): { state: BargeInControllerState; action: BargeInAction } {
  if (state.phase !== 'idle') return { state, action: { type: 'noop' } };
  return { state: { phase: 'ducked', utteranceId }, action: { type: 'duck', utteranceId } };
}

/**
 * 近端発話の観測更新（継続時間が伸びる・テキストが確定する等）を反映し、分類結果に応じて
 * アクションを返す。`pending` の間は ducked のまま複数回呼ばれる想定。
 */
export function onNearEndUpdate(
  state: BargeInControllerState,
  signal: NearEndSignal,
  config?: NearEndClassifierConfig,
): { state: BargeInControllerState; action: BargeInAction; classification: NearEndClassification } {
  if (state.phase !== 'ducked' || !state.utteranceId) {
    return { state, action: { type: 'noop' }, classification: 'pending' };
  }

  const classification = classifyNearEnd(signal, config);
  const utteranceId = state.utteranceId;

  if (classification === 'pending') {
    return { state, action: { type: 'await' }, classification };
  }

  if (shouldStopPlayback(classification)) {
    return {
      state: { phase: 'stopped', utteranceId },
      action: { type: 'stop_and_discard', utteranceId, vrmState: 'listening' },
      classification,
    };
  }

  // backchannel / noise / echo は再生を継続する。
  return { state: { phase: 'idle', utteranceId: null }, action: { type: 'resume', utteranceId, classification }, classification };
}

/** `BargeInAction` を `TtsBargeInPort` の呼び出しへ適用する（副作用の集約点）。 */
export function applyBargeInAction(action: BargeInAction, port: TtsBargeInPort): void {
  switch (action.type) {
    case 'duck':
      port.duck(action.utteranceId);
      break;
    case 'resume':
      port.resume(action.utteranceId);
      break;
    case 'stop_and_discard':
      port.stopPlayback(action.utteranceId);
      port.discardQueuedAudio(action.utteranceId);
      break;
    case 'await':
    case 'noop':
      break;
  }
}
