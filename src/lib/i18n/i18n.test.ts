import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
  t,
  makeT,
  DICTIONARIES,
  type Locale,
  type MessageKey,
} from './index';

describe('t 補間 (#103)', () => {
  it('{name} を params で置換する', () => {
    expect(t('reception.callingBody', 'ja', { target: '佐藤 太郎' })).toContain('佐藤 太郎');
    expect(t('reception.callingBody', 'en', { target: 'Sato' })).toBe(
      'Calling Sato. Please wait a moment.',
    );
  });

  it('params 未指定ならプレースホルダはそのまま残す（壊さない）', () => {
    expect(t('reception.callingBody', 'en')).toContain('{target}');
  });

  it('未知のプレースホルダは置換せず残す', () => {
    expect(t('reception.callingBody', 'en', { other: 'x' })).toContain('{target}');
  });

  it('makeT も params を受け付ける', () => {
    const tr = makeT('en');
    expect(tr('reception.connectedBody', { target: 'Sato' })).toBe(
      'Sato answered and will come to meet you shortly. Please wait here—no action is needed.',
    );
  });
});

describe('normalizeLocale (#103)', () => {
  it('対応 locale はそのまま返す', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('ja')).toBe('ja');
  });

  it('大文字・地域サブタグを正規化する', () => {
    expect(normalizeLocale('EN')).toBe('en');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('zh-Hans')).toBe('zh');
    expect(normalizeLocale('ko_KR')).toBe('ko');
  });

  it('対応外・未指定は既定 locale へフォールバックする', () => {
    expect(normalizeLocale('fr')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(123)).toBe(DEFAULT_LOCALE);
  });

  it('fallback 引数を尊重する', () => {
    expect(normalizeLocale('fr', 'en')).toBe('en');
  });

  it("ハイフンを含む完全一致の locale は region subtag 除去より先に判定する（'ja-simple' が 'ja' に潰れない, #321）", () => {
    expect(normalizeLocale('ja-simple')).toBe('ja-simple');
    expect(normalizeLocale('JA-SIMPLE')).toBe('ja-simple');
  });
});

describe('isSupportedLocale (#103)', () => {
  it('対応言語のみ true', () => {
    expect(isSupportedLocale('ja')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });
});

describe('t() / makeT() (#103)', () => {
  it('指定 locale の文言を返す', () => {
    expect(t('welcome.title', 'en')).toBe('Welcome');
    expect(t('welcome.title', 'ja')).toBe('ようこそ');
    expect(t('welcome.title', 'ko')).toBe('환영합니다');
    expect(t('welcome.title', 'zh')).toBe('欢迎');
  });

  it('locale 省略時は既定 locale を使う', () => {
    expect(t('welcome.title')).toBe(t('welcome.title', DEFAULT_LOCALE));
  });

  it('対応外 locale は既定 locale へフォールバックする', () => {
    expect(t('welcome.title', 'fr' as never)).toBe(t('welcome.title', DEFAULT_LOCALE));
  });

  it('makeT は locale を束縛する', () => {
    const tr = makeT('en');
    expect(tr('common.next')).toBe('Next');
    expect(tr('common.cancel')).toBe('Cancel');
  });
});

describe('dictionary 整合 (#103)', () => {
  const keys = Object.keys(DICTIONARIES[DEFAULT_LOCALE]) as Array<keyof typeof DICTIONARIES['ja']>;

  it('既定 locale が全キーを網羅し空文字が無い', () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect((DICTIONARIES[DEFAULT_LOCALE][key] ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('全対応 locale で全キーが（フォールバック込みで）非空に解決する', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect(t(key, locale).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('各 locale 辞書に未定義キーが混入していない', () => {
    const allowed = new Set<string>(keys as string[]);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(DICTIONARIES[locale])) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

describe('locale 網羅の機械検証 (#327)', () => {
  const jaKeys = Object.keys(DICTIONARIES[DEFAULT_LOCALE]) as Array<keyof typeof DICTIONARIES['ja']>;

  /**
   * 意図的な部分網羅（bounded scope）の例外リスト (#321)。
   *
   * 'ja-simple'（やさしい日本語）は「全画面の網羅はしない」方針の支援モードで、主要フロー画面の
   * キーのみを持つ。欠落キーは `t()` の既存フォールバック（既定 locale=ja）でそのまま解決される
   * ため、この locale だけは以下 2 テスト（完全一致・非空文字の全数検証）の対象から明示的に除外する。
   * それ以外の対応言語（ja/en/ko/zh）は #327 の方針どおり全キー網羅を維持する。
   */
  const PARTIAL_COVERAGE_LOCALES = new Set<Locale>(['ja-simple']);
  const strictLocales = SUPPORTED_LOCALES.filter((locale) => !PARTIAL_COVERAGE_LOCALES.has(locale));

  it('全 locale が既定 locale (ja) と同一のキー集合を持つ（欠落キーが無い、ja-simple を除く）', () => {
    for (const locale of strictLocales) {
      const keys = new Set(Object.keys(DICTIONARIES[locale]));
      const missing = jaKeys.filter((key) => !keys.has(key));
      expect(missing, `locale=${locale} に欠落しているキー`).toEqual([]);
    }
  });

  it('全 locale の全キーが非空文字（フォールバックに頼らない実値を持つ、ja-simple を除く）', () => {
    for (const locale of strictLocales) {
      for (const key of jaKeys) {
        const value = DICTIONARIES[locale][key];
        expect(value, `locale=${locale} key=${key}`).toBeTruthy();
        expect((value ?? '').trim().length, `locale=${locale} key=${key}`).toBeGreaterThan(0);
      }
    }
  });

  describe('ja-simple（やさしい日本語, #321）の意図的な部分網羅', () => {
    it('未整備キーは非空のまま（既定 locale=ja へフォールバックして解決する）', () => {
      for (const key of jaKeys) {
        expect(t(key, 'ja-simple').trim().length, `key=${key}`).toBeGreaterThan(0);
      }
    });

    it('定義済みキーは全て非空文字（実値を持つ）', () => {
      for (const [key, value] of Object.entries(DICTIONARIES['ja-simple'])) {
        expect((value ?? '').trim().length, `key=${key}`).toBeGreaterThan(0);
      }
    });

    it('主要フロー画面のキーを実際に持つ（bounded scope の要点を機械検証）', () => {
      const mustHave: MessageKey[] = [
        'welcome.title',
        'reception.purposePrompt',
        'reception.targetPrompt',
        'reception.visitorInfoPrompt',
        'reception.confirm',
        'reception.callingBody',
        'reception.thanks',
      ];
      for (const key of mustHave) {
        expect(DICTIONARIES['ja-simple'][key], `key=${key}`).toBeTruthy();
      }
    });

    it('全画面は網羅しない（bounded scope が維持されていることを確認する）', () => {
      const jaSimpleKeyCount = Object.keys(DICTIONARIES['ja-simple']).length;
      expect(jaSimpleKeyCount).toBeLessThan(jaKeys.length);
    });
  });
});
