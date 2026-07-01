import { describe, expect, it } from 'vitest';
import { byFlagRankTimeDesc } from './scoped-summary';

type Row = { id: string; flag: boolean; rank: number; time: string };

const cmp = byFlagRankTimeDesc<Row>({
  flagOf: (r) => r.flag,
  rankOf: (r) => r.rank,
  timeOf: (r) => r.time,
});

function sorted(rows: Row[]): string[] {
  return [...rows].sort(cmp).map((r) => r.id);
}

describe('byFlagRankTimeDesc (#251 共有並べ替え契約)', () => {
  it('flag=true を先頭に並べる', () => {
    expect(
      sorted([
        { id: 'off', flag: false, rank: 9, time: 'z' },
        { id: 'on', flag: true, rank: 0, time: 'a' },
      ]),
    ).toEqual(['on', 'off']);
  });

  it('同一 flag 内は rank 降順', () => {
    expect(
      sorted([
        { id: 'low', flag: true, rank: 1, time: 'a' },
        { id: 'high', flag: true, rank: 3, time: 'a' },
        { id: 'mid', flag: true, rank: 2, time: 'a' },
      ]),
    ).toEqual(['high', 'mid', 'low']);
  });

  it('同一 flag・同一 rank 内は time 降順（新しい順）', () => {
    expect(
      sorted([
        { id: 'old', flag: true, rank: 1, time: '2026-06-20T00:00:00.000Z' },
        { id: 'new', flag: true, rank: 1, time: '2026-06-24T00:00:00.000Z' },
      ]),
    ).toEqual(['new', 'old']);
  });
});
