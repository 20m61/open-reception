/**
 * 翻訳取得の純関数 `t(key, locale)` (issue #103, increment 1)。
 *
 * フォールバック順:
 *   1. 指定 locale の辞書に key があればそれを返す。
 *   2. 無ければ既定 locale (ja) の辞書を返す（既定は全キー網羅済み = 必ずヒット）。
 *
 * I/O も状態も持たない純関数。React 側は useLocale() 等から locale を受け取り本関数を呼ぶ。
 */
import { DICTIONARIES, type MessageKey } from './dictionary';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from './locale';

/** 補間パラメータ。文中の `{name}` を値で置換する（例: `{target}`）。 */
export type TParams = Record<string, string | number>;

/** `{name}` プレースホルダを params で置換する。未指定キーはそのまま残す（壊さない）。 */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * key を locale で翻訳する。未対応 locale は正規化で既定へ寄せ、欠落キーは既定 locale へ
 * フォールバックする。既定にも無い場合（型上は起こらない）は key 文字列を返す。
 * params を渡すと文中の `{name}` を置換する。
 */
export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE, params?: TParams): string {
  const normalized = normalizeLocale(locale);
  const template = DICTIONARIES[normalized][key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, params);
}

/** 指定 locale 用に固定した翻訳関数を作る（コンポーネントで `const tr = makeT(locale)`）。 */
export function makeT(locale: Locale): (key: MessageKey, params?: TParams) => string {
  const normalized = normalizeLocale(locale);
  return (key, params) => t(key, normalized, params);
}
