/**
 * ターン終了判定・barge-in の共通型 (issue #372)。
 *
 * `src/domain/voice-transport/` (#369) / `src/domain/voice-tts/` (#371) と同じ流儀 ——
 * ここは純データ型と Smart Turn 等へ置換可能な **contract (interface)** のみを持つ。
 * 実 VAD 実装・実 STT 部分認識・実タイマーは `src/lib/voice-turn/`（将来配線）が担う。
 */

/**
 * 現在聞いている入力スロット。氏名・部門・自由用件で無音の許容時間や短答判定の重みが変わる
 * （issue #372「現在聞いているslot（氏名、部門、自由用件）を判定へ入力する」）。
 */
export type TurnSlot = 'name' | 'department' | 'purpose' | 'free_form';

/**
 * VAD の 1 フレーム観測（合成可能な形。実 provider は energy/確率のどちらから来てもよい）。
 * 生波形・音声 URI は持たない（#365 のデータ方針を踏襲）。
 */
export type VadFrame = {
  /** セッション/発話内の相対ミリ秒。単調増加であること。 */
  tMs: number;
  /** 発話確率（0..1）。単純なエネルギー閾値実装は 0/1 に丸めた値を渡してもよい。 */
  speechProbability: number;
};

/** VAD が検出した音声区間（onset/offset の対）。 */
export type VadSegment = {
  onsetMs: number;
  /** 区間がまだ終わっていない（現在も発話中）場合は null。 */
  offsetMs: number | null;
};

/**
 * VAD adapter contract。閾値ベースの参照実装 (`vad.ts` の `EnergyThresholdVadAdapter`) から
 * Smart Turn 等の学習済みモデルへ置換可能にするための境界。
 */
export interface VadAdapter {
  /** フレーム列から音声区間を検出する。フレームは時刻順であること。 */
  detectSegments(frames: readonly VadFrame[]): VadSegment[];
}
