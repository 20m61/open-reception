import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from './parse';

describe('parseCsv', () => {
  it('単純な CSV を解析する', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引用内のカンマを保持する', () => {
    expect(parseCsv('name\n"佐藤, 太郎"')).toEqual([['name'], ['佐藤, 太郎']]);
  });

  it('"" を引用内のダブルクオートとして扱う', () => {
    expect(parseCsv('x\n"a""b"')).toEqual([['x'], ['a"b']]);
  });

  it('空行を除去する', () => {
    expect(parseCsv('a\n\n1\n')).toEqual([['a'], ['1']]);
  });
});

describe('parseCsvRecords', () => {
  it('ヘッダ付きレコードへ変換する', () => {
    const { headers, records } = parseCsvRecords('name,kana\n営業部,えいぎょう');
    expect(headers).toEqual(['name', 'kana']);
    expect(records).toEqual([{ name: '営業部', kana: 'えいぎょう' }]);
  });

  it('値の前後空白を除去する', () => {
    const { records } = parseCsvRecords('name\n  営業部  ');
    expect(records[0]?.name).toBe('営業部');
  });
});
