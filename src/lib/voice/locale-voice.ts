/**
 * locale → TTS 音声 / 言語コード選択 (issue #103, increment 1)。
 *
 * 役割:
 *   - UI locale ('ja'|'en'|'ko'|'zh') から TTS 用の言語コード（BCP-47, 例 'ja-JP'）と
 *     既定 voiceId を純関数で導出する。
 *   - 設定（VoiceSettings.localeVoices）に locale 別の上書きがあればそれを優先し、
 *     未設定の locale は本モジュールの既定マップへフォールバックする。
 *
 * 方針 (#103):
 *   - TTS は補助。未対応・未設定 locale は既定 locale (ja) の音声へフォールバックし、
 *     さらに音声自体が失敗しても画面文言で受付を完走できる（voice-store.fallbackText）。
 *   - voiceId はプロバイダ非依存の論理名は持たず、Polly 等の実 voiceId をそのまま設定で持つ
 *     想定。未設定時は空文字を返し、上位（browser SpeechSynthesis 等）が lang から既定音声を選ぶ。
 *
 * ライセンス (#105): TTS の音声モデル（Polly voiceId 等）の利用規約は採用時に確認する。
 * 本モジュールは選択ロジックのみで、音声合成は src/server/notification/polly-adapter.ts。
 */
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '@/lib/i18n';
import type { LocaleVoice, VoiceSettings } from '@/domain/voice/types';

/** locale → TTS 言語コード（BCP-47）の既定マップ。 */
export const LOCALE_LANGUAGE_CODE: Record<Locale, string> = {
  ja: 'ja-JP',
  en: 'en-US',
  ko: 'ko-KR',
  zh: 'cmn-CN',
};

/**
 * 設定と locale から TTS の言語コード・voiceId・話速・音量を解決する。
 *
 * 解決順:
 *   1. settings.localeVoices[locale] に上書きがあれば、その languageCode / voiceId を使う。
 *   2. 無ければ LOCALE_LANGUAGE_CODE[locale] を言語コードに、voiceId は空（lang から既定選択）。
 *   3. locale が対応外なら既定 locale (ja) へフォールバックして 1→2 を再評価する。
 *
 * rate / volume は locale 非依存の共通設定を引き継ぐ。
 */
export function resolveLocaleVoice(
  settings: Pick<VoiceSettings, 'rate' | 'volume' | 'localeVoices'>,
  locale: Locale = DEFAULT_LOCALE,
): { languageCode: string; voiceId: string; rate: number; volume: number } {
  const normalized = normalizeLocale(locale);
  const override = pickOverride(settings.localeVoices, normalized);
  return {
    languageCode: override?.languageCode || LOCALE_LANGUAGE_CODE[normalized],
    voiceId: override?.voiceId ?? '',
    rate: settings.rate,
    volume: settings.volume,
  };
}

/** locale の上書きを取り出す。未設定なら既定 locale の上書きへフォールバックする。 */
function pickOverride(
  localeVoices: VoiceSettings['localeVoices'],
  locale: Locale,
): LocaleVoice | undefined {
  if (!localeVoices) return undefined;
  return localeVoices[locale] ?? localeVoices[DEFAULT_LOCALE];
}
