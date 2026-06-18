/**
 * 音声設定のドメイン型 (issue #28)。
 * 音声合成(TTS)・音声認識(STT)・案内文言・話速・音量・言語を扱う。
 * 方針: タッチ操作を主導線とし、音声は補助。音声不可でもテキストで完走する。
 */
export type VoiceProvider = 'browser' | 'none';

export type VoiceSettings = {
  ttsEnabled: boolean;
  sttEnabled: boolean;
  ttsProvider: VoiceProvider;
  sttProvider: VoiceProvider;
  voiceId: string;
  /** 話速 0.5–2.0。 */
  rate: number;
  /** 音量 0–1。 */
  volume: number;
  language: string;
  /** 各画面の案内文言。 */
  guidanceIdle: string;
  guidanceConfirm: string;
  /** 音声再生不可時の案内（テキスト fallback）。 */
  fallbackText: string;
};

export function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}
