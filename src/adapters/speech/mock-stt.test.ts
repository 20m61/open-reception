import { describe, expect, it } from 'vitest';
import { MockSttAdapter } from './mock-stt';

describe('MockSttAdapter', () => {
  it('候補テキストを返す', async () => {
    const candidates = await new MockSttAdapter(['さとう', 'すずき']).listen();
    expect(candidates).toEqual(['さとう', 'すずき']);
  });

  it('空文字・空白のみの候補は除外する', async () => {
    const candidates = await new MockSttAdapter(['さとう', '', '  ', 'すずき']).listen();
    expect(candidates).toEqual(['さとう', 'すずき']);
  });

  it('候補は最大 3 件に制限する', async () => {
    const candidates = await new MockSttAdapter(['a', 'b', 'c', 'd', 'e']).listen();
    expect(candidates).toHaveLength(3);
    expect(candidates).toEqual(['a', 'b', 'c']);
  });

  it('候補が無い場合は空配列を返す（即時呼び出ししない）', async () => {
    const candidates = await new MockSttAdapter([]).listen();
    expect(candidates).toEqual([]);
  });
});
