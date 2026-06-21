/**
 * i18n 基盤の locale 型と定数 (issue #103, increment 1)。
 *
 * 方針 (#103):
 *   - 対応順は 日本語 → 英語 → 韓国語 → 中国語。
 *   - 既定 locale は日本語。未対応 locale は既定へフォールバックする。
 *   - locale 判定・正規化は純関数で行い、I/O を持たない（テスト容易性）。
 *
 * このモジュールは「どの言語を扱うか」だけを定義する。翻訳文言は dictionary.ts、
 * 取り出しは t.ts、TTS の音声/言語コード選択は src/lib/voice/locale-voice.ts が担う。
 */

/** 受付がサポートする UI / TTS 言語。 */
export const SUPPORTED_LOCALES = ['ja', 'en', 'ko', 'zh'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 既定 locale。未対応・未設定時のフォールバック先 (#103: 日本語が基準)。 */
export const DEFAULT_LOCALE: Locale = 'ja';

/** 各 locale の自言語表示名（言語切替 UI で使う。翻訳に依存しない固定値）。 */
export const LOCALE_NATIVE_LABEL: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
  ko: '한국어',
  zh: '中文',
};

/** locale が対応言語かどうか。 */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * 任意の入力（クエリ・設定・Accept-Language の primary subtag 等）を対応 locale へ正規化する。
 * 対応外・未指定は既定 locale を返す。`fallback` で既定以外を指定できる。
 *
 * 例: 'EN' → 'en', 'ja-JP' → 'ja', 'zh-Hans' → 'zh', 'fr' → DEFAULT_LOCALE。
 */
export function normalizeLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (typeof value !== 'string') return fallback;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(primary) ? primary : fallback;
}
