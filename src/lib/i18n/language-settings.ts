/**
 * 有効言語・既定言語の設定 (issue #103, increment 1・任意スコープ)。
 *
 * 受付端末でどの言語を出すか（enabledLocales）と、初期表示 locale（defaultLocale）を
 * テナント運用者が選べるようにする。永続化は voice-store と同じく singleton backend に委譲。
 *
 * 純関数 sanitizeLanguageSettings を分離してテスト対象とする（I/O は store 側のみ）。
 * 不変条件:
 *   - enabledLocales は対応 locale の重複なし部分集合。空なら既定 locale のみへ補正。
 *   - defaultLocale は必ず enabledLocales に含まれる（含まれなければ先頭へ補正）。
 */
import { getBackend } from '@/lib/data';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from './locale';

export type LanguageSettings = {
  /** 受付で選択肢として出す言語。 */
  enabledLocales: Locale[];
  /** 受付の初期表示 locale。enabledLocales に含まれること。 */
  defaultLocale: Locale;
};

function defaults(): LanguageSettings {
  return { enabledLocales: [DEFAULT_LOCALE], defaultLocale: DEFAULT_LOCALE };
}

/**
 * 任意入力を不変条件を満たす LanguageSettings へ補正する純関数。
 * 対応外 locale は除外、重複は排除、空集合は既定のみ、defaultLocale は enabled 内へ。
 * SUPPORTED_LOCALES の順序を保って安定化する。
 */
export function sanitizeLanguageSettings(input: unknown, base: LanguageSettings = defaults()): LanguageSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const requested = Array.isArray(o.enabledLocales) ? o.enabledLocales : base.enabledLocales;
  const enabledSet = new Set<Locale>();
  for (const value of requested) {
    if (isSupportedLocale(value)) enabledSet.add(value);
  }
  let enabledLocales = SUPPORTED_LOCALES.filter((l) => enabledSet.has(l));
  if (enabledLocales.length === 0) enabledLocales = [DEFAULT_LOCALE];

  const requestedDefault = isSupportedLocale(o.defaultLocale) ? o.defaultLocale : base.defaultLocale;
  const defaultLocale: Locale = enabledLocales.includes(requestedDefault)
    ? requestedDefault
    : (enabledLocales[0] ?? DEFAULT_LOCALE);

  return { enabledLocales, defaultLocale };
}

const store = () => getBackend().singleton<LanguageSettings>('language-settings', { default: defaults });

export async function getLanguageSettings(): Promise<LanguageSettings> {
  return sanitizeLanguageSettings(await store().get());
}

export async function updateLanguageSettings(patch: unknown): Promise<LanguageSettings> {
  const next = sanitizeLanguageSettings(patch, await getLanguageSettings());
  await store().put(next);
  return next;
}

/** テスト用: 既定へ戻す。 */
export async function __resetLanguageSettings(): Promise<void> {
  await store().reset();
}
