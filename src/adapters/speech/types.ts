/**
 * 音声合成(TTS)・音声認識(STT)の adapter 境界 (issue #28)。
 * 本番では Web Speech API や外部サービスの実装に差し替える。
 */
export type TtsOptions = { rate?: number; volume?: number; voiceId?: string; language?: string };

export interface TtsAdapter {
  /** テキストを読み上げる。失敗時も例外で受付を止めないこと。 */
  speak(text: string, options?: TtsOptions): Promise<void>;
}

export interface SttAdapter {
  /**
   * 音声を認識して候補テキストを返す。
   * 認識結果は必ず候補として扱い、来訪者の確認操作を挟む（即時呼び出ししない）。
   */
  listen(): Promise<string[]>;
}
