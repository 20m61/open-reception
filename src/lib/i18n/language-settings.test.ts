import { describe, expect, it } from 'vitest';
import { sanitizeLanguageSettings } from './language-settings';

describe('sanitizeLanguageSettings (#103)', () => {
  it('既定は ja のみ・既定 locale は ja', () => {
    expect(sanitizeLanguageSettings(undefined)).toEqual({
      enabledLocales: ['ja'],
      defaultLocale: 'ja',
    });
  });

  it('対応外 locale を除外し SUPPORTED_LOCALES 順に並べる', () => {
    const r = sanitizeLanguageSettings({ enabledLocales: ['zh', 'fr', 'en', 'ja'], defaultLocale: 'en' });
    expect(r.enabledLocales).toEqual(['ja', 'en', 'zh']);
    expect(r.defaultLocale).toBe('en');
  });

  it('重複 locale を排除する', () => {
    expect(sanitizeLanguageSettings({ enabledLocales: ['en', 'en', 'ja'] }).enabledLocales).toEqual(['ja', 'en']);
  });

  it('空集合は既定 locale のみへ補正する', () => {
    expect(sanitizeLanguageSettings({ enabledLocales: [] }).enabledLocales).toEqual(['ja']);
    expect(sanitizeLanguageSettings({ enabledLocales: ['fr', 'de'] }).enabledLocales).toEqual(['ja']);
  });

  it('defaultLocale が有効言語外なら先頭へ補正する', () => {
    const r = sanitizeLanguageSettings({ enabledLocales: ['en', 'ko'], defaultLocale: 'ja' });
    expect(r.enabledLocales).toEqual(['en', 'ko']);
    expect(r.defaultLocale).toBe('en');
  });

  it('非オブジェクト入力は base を尊重する', () => {
    const base = { enabledLocales: ['ja', 'en'] as const, defaultLocale: 'en' as const };
    expect(sanitizeLanguageSettings(null, { ...base, enabledLocales: [...base.enabledLocales] })).toEqual({
      enabledLocales: ['ja', 'en'],
      defaultLocale: 'en',
    });
  });
});
