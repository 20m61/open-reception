/**
 * i18n 基盤の公開エントリ (issue #103, increment 1)。
 * locale 型・辞書・翻訳関数をまとめて re-export する。
 */
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_NATIVE_LABEL,
  isSupportedLocale,
  normalizeLocale,
  htmlLangFor,
  type Locale,
} from './locale';
export { DICTIONARIES, type MessageKey } from './dictionary';
export { t, makeT, type TParams } from './t';
