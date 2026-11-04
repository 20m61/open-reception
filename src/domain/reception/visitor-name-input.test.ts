import { describe, expect, it } from 'vitest';
import { VISITOR_NAME_MAX_LENGTH, isVisitorNameWithinLimit, normalizeVisitorNameInput } from './session';

/**
 * 氏名の入力値の正規化 (#1290)。キーボードでも音声でも、入力欄・保存値へ入る前に通す。
 * 前後の空白とゼロ幅文字（Default_Ignorable_Code_Point）を落とす。中の文字は変えない。
 */
describe('normalizeVisitorNameInput', () => {
  it('前後の空白（全角を含む）を落とす', () => {
    expect(normalizeVisitorNameInput('  山田 太郎　')).toBe('山田 太郎');
  });

  it('前後のゼロ幅文字を落とす（見えない文字が保存値や復唱に混ざらない）', () => {
    for (const zw of ['​', '‌', '‍', '⁠', '﻿', '­']) {
      expect(normalizeVisitorNameInput(`${zw}山田${zw}`), JSON.stringify(zw)).toBe('山田');
    }
    expect(normalizeVisitorNameInput('​ ​山田 ​ ')).toBe('山田');
  });

  it('中のゼロ幅文字・空白は変えない（名前の一部を勝手に書き換えない）', () => {
    expect(normalizeVisitorNameInput('山​田')).toBe('山​田');
    expect(normalizeVisitorNameInput('山田 太郎')).toBe('山田 太郎');
  });

  it('見える文字が無ければ空になる', () => {
    expect(normalizeVisitorNameInput('​　 ﻿')).toBe('');
  });

  it('前後のゼロ幅文字は上限の数に入らない', () => {
    const name = 'あ'.repeat(VISITOR_NAME_MAX_LENGTH);
    expect(isVisitorNameWithinLimit(`​${name}`)).toBe(false);
    expect(isVisitorNameWithinLimit(normalizeVisitorNameInput(`​${name}​`))).toBe(true);
  });
});
