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
 *
 * `ja-simple`（やさしい日本語, issue #321）:
 *   - 来訪者向けアクセシビリティ支援モードの 1 つとして、通常の言語一覧とは別枠の
 *     `Locale` 値として扱う（`t()`/`makeT()` 等の既存 locale 解決経路をそのまま再利用するため）。
 *   - 通常の LanguageSwitcher（表示言語選択）には出さず、専用の支援モードパネルからのみ選ばせる
 *     （`src/components/kiosk/LanguageSwitcher.tsx` が `SUPPORTED_LOCALES` から除外する）。
 *   - 辞書（dictionary.ts）は「主要フロー画面のみ」の意図的な部分網羅（bounded scope）。
 *     未整備キーは `t()` の既存フォールバック（既定 locale=ja）でそのまま解決される。
 *     機械検証（i18n.test.ts の #327 locale 網羅テスト）はこの意図的な例外を明示している。
 */

/** 受付がサポートする UI / TTS 言語。'ja-simple' は #321 のやさしい日本語支援モード。 */
export const SUPPORTED_LOCALES = ['ja', 'en', 'ko', 'zh', 'ja-simple'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 既定 locale。未対応・未設定時のフォールバック先 (#103: 日本語が基準)。 */
export const DEFAULT_LOCALE: Locale = 'ja';

/** 各 locale の自言語表示名（言語切替 UI で使う。翻訳に依存しない固定値）。 */
export const LOCALE_NATIVE_LABEL: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
  ko: '한국어',
  zh: '中文',
  'ja-simple': 'やさしい日本語',
};

/**
 * HTML `lang` 属性用の BCP-47 サブタグへ変換する (#321)。
 *
 * `ja-simple` はアプリ内部の識別子であって有効な BCP-47 言語タグではない（axe の
 * `valid-lang` ルールに抵触する）。文言の実体は日本語なので `lang="ja"` へ写す。
 * 他の locale はそのまま返す（既に BCP-47 の主言語サブタグと一致する）。
 */
export function htmlLangFor(locale: Locale): string {
  return locale === 'ja-simple' ? 'ja' : locale;
}

/** locale が対応言語かどうか。 */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * 任意の入力（クエリ・設定・Accept-Language の primary subtag 等）を対応 locale へ正規化する。
 * 対応外・未指定は既定 locale を返す。`fallback` で既定以外を指定できる。
 *
 * 例: 'EN' → 'en', 'ja-JP' → 'ja', 'zh-Hans' → 'zh', 'fr' → DEFAULT_LOCALE。
 *
 * 完全一致を先に見る (#321): 'ja-simple' はハイフンを含むがそれ自体が対応 locale の完全な値
 * なので、region subtag 除去（'ja-JP' → 'ja' 等）のヒューリスティックより先に完全一致を試す。
 * 先に primary subtag へ割ってしまうと 'ja-simple' が 'ja' に潰れて支援モードを区別できない。
 */
export function normalizeLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toLowerCase();
  if (isSupportedLocale(trimmed)) return trimmed;
  const primary = trimmed.split(/[-_]/)[0];
  return isSupportedLocale(primary) ? primary : fallback;
}
