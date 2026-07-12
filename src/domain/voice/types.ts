/**
 * 音声設定のドメイン型 (issue #28)。
 * 音声合成(TTS)・音声認識(STT)・案内文言・話速・音量・言語を扱う。
 * 方針: タッチ操作を主導線とし、音声は補助。音声不可でもテキストで完走する。
 */
export type VoiceProvider = 'browser' | 'none';

/**
 * locale 別の TTS 上書き (issue #103)。未設定の locale は既定マップ
 * (src/lib/voice/locale-voice.ts: LOCALE_LANGUAGE_CODE) へフォールバックする。
 */
export type LocaleVoice = {
  /** TTS 言語コード（BCP-47, 例 'en-US'）。 */
  languageCode: string;
  /** プロバイダ固有の voiceId（例 Polly 'Joanna'）。空なら lang から既定音声を選ぶ。 */
  voiceId: string;
};

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
  /**
   * locale 別 TTS 上書き (issue #103)。任意。未設定 locale は既定言語コードへ
   * フォールバックする（resolveLocaleVoice 参照）。後方互換のため optional。
   */
  localeVoices?: Partial<Record<string, LocaleVoice>>;
  /**
   * 来訪者向けプライバシー通知の要約文言の上書き (issue #314)。任意（既存 guidanceIdle 等と
   * 同じ「案内文言設定」画面の仕組みを流用）。未設定/空文字は既定 locale (ja) でも
   * i18n 辞書の既定文言（実装実態に即した文言）へフォールバックする。他 locale へは適用しない
   * （src/components/kiosk/privacy-notice.ts の resolvePrivacyNoticeContent 参照）。
   * 後方互換のため optional（既存永続データに無くても壊れない）。
   */
  privacyNotice?: string;
};

export function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

export function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}
