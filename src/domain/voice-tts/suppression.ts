/**
 * 通話中のキャラクター TTS 抑止 (issue #371 設計方針: 「通話接続中はキャラクターTTSを停止する」)。
 *
 * 設計方針: `src/domain/voice-transport/fallback.ts`（#369）と同じく、他トラック占有のドメイン
 * （`src/domain/reception/ui-contract.ts` の `ReceptionState`、`src/domain/routing/policy.ts` の
 * `RouteAction`）へ依存しない**中立な状態入力**を受け取る純関数として定義する。
 *
 * 対応関係（配線は次周回・呼び出し側が変換する）:
 *  - `callConnected` ← `ReceptionState === 'connected'`（通話中, #361/#362 側の状態機械）。
 *  - `liveBridgeActive` ← 進行中の `RoutingStep.action === 'live_bridge'`（#374 側の Orchestrator）。
 */
export type TtsSuppressionInput = {
  /** 通話（PSTN 等）が接続中か。 */
  callConnected: boolean;
  /** ルーティング中の step が live_bridge（即通話）動作中か。 */
  liveBridgeActive: boolean;
};

/**
 * キャラクター TTS を抑止すべきか。通話が接続中、または live_bridge 動作が進行中のいずれかで
 * true（issue #371 AC）。
 */
export function shouldSuppressCharacterTts(input: TtsSuppressionInput): boolean {
  return input.callConnected || input.liveBridgeActive;
}
