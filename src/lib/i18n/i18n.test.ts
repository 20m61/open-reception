import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
  t,
  makeT,
  DICTIONARIES,
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
      'Sato answered. They will be with you shortly.',
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
