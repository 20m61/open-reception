import { describe, it, expect } from 'vitest';
import { tokenFromUrl } from './token-from-url';

describe('tokenFromUrl (#239)', () => {
  it('fragment（#token=）から読む（サーバログ非露出の主経路）', () => {
    expect(tokenFromUrl({ hash: '#token=abc', search: '' })).toBe('abc');
    expect(tokenFromUrl({ hash: 'token=abc', search: '' })).toBe('abc'); // 先頭 # なしも可。
  });

  it('query（?token=）はフォールバックで読む（旧 URL 互換）', () => {
    expect(tokenFromUrl({ hash: '', search: '?token=legacy' })).toBe('legacy');
  });

  it('fragment を query より優先する', () => {
    expect(tokenFromUrl({ hash: '#token=frag', search: '?token=query' })).toBe('frag');
  });

  it('どちらにも無ければ空文字', () => {
    expect(tokenFromUrl({ hash: '', search: '' })).toBe('');
    expect(tokenFromUrl({ hash: '#other=1', search: '?x=2' })).toBe('');
  });

  it('URL エンコードされた値をデコードする', () => {
    expect(tokenFromUrl({ hash: '#token=a%2Bb%3Dc', search: '' })).toBe('a+b=c');
  });
});
