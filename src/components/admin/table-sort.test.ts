import { describe, expect, it } from 'vitest';
import { ariaSortFor, nextSortState, sortRows, type SortState } from './list-io';

/**
 * 一覧の並べ替え (#909 / 課題 18)。
 *
 * 縛るのは列ごとの期待値ではなく**不変条件**。「日時列を降順にすると最新が先頭に来る」
 * 式の主張だけを並べると、比較関数の書き換え（安定性の喪失・解除の消失）が素通りする。
 */

type Row = { id: string; name: string; n: number };

const COLUMNS = [
  { key: 'name', sortValue: (r: Row) => r.name },
  { key: 'n', sortValue: (r: Row) => r.n },
  { key: 'actions' }, // sortValue なし = ソート不可
] as const;

const ROWS: Row[] = [
  { id: 'a', name: 'かきくけこ', n: 2 },
  { id: 'b', name: 'あいうえお', n: 10 },
  { id: 'c', name: 'さしすせそ', n: 2 },
  { id: 'd', name: 'あいうえお', n: 9 },
];

const ids = (rows: readonly Row[]) => rows.map((r) => r.id).join('');

describe('sortRows', () => {
  it('指定が無ければ元の順序をそのまま返す', () => {
    expect(sortRows(ROWS, COLUMNS, undefined)).toBe(ROWS);
  });

  it('ソート不可の列を指定されても元の順序を返す', () => {
    // 下界: 「列が無ければ適当に並べる」実装をここで落とす。
    expect(sortRows(ROWS, COLUMNS, { key: 'actions', direction: 'asc' })).toBe(ROWS);
    expect(sortRows(ROWS, COLUMNS, { key: '存在しない', direction: 'asc' })).toBe(ROWS);
  });

  it('昇順と降順が互いの逆になる（同値の塊を除いて）', () => {
    const asc = sortRows(ROWS, COLUMNS, { key: 'n', direction: 'asc' });
    const desc = sortRows(ROWS, COLUMNS, { key: 'n', direction: 'desc' });
    expect(asc.map((r) => r.n)).toEqual([2, 2, 9, 10]);
    expect(desc.map((r) => r.n)).toEqual([10, 9, 2, 2]);
  });

  it('安定である（同値の相対順序が元のまま）', () => {
    /*
     * 監査ログのように**取得順に意味がある**一覧では、同値のかたまりの中の順序が
     * 毎回変わると読みにくい。a と c は n=2 で同値なので、元の順序（a → c）を保つ。
     */
    const asc = sortRows(ROWS, COLUMNS, { key: 'n', direction: 'asc' });
    expect(ids(asc)).toBe('acdb');
    const desc = sortRows(ROWS, COLUMNS, { key: 'n', direction: 'desc' });
    // 降順でも同値の塊の中は元の順序（a → c）。逆順にはしない。
    expect(ids(desc)).toBe('bdac');
  });

  it('数値は数値として比べる（文字列比較にしない）', () => {
    // 下界: 文字列比較だと 10 < 2 になる。
    const asc = sortRows(ROWS, COLUMNS, { key: 'n', direction: 'asc' });
    expect(asc[asc.length - 1]?.n).toBe(10);
  });

  it('元の配列を破壊しない', () => {
    const before = ids(ROWS);
    sortRows(ROWS, COLUMNS, { key: 'name', direction: 'desc' });
    expect(ids(ROWS)).toBe(before);
  });
});

describe('nextSortState', () => {
  it('asc → desc → 解除 で 1 周する', () => {
    const first = nextSortState(undefined, 'name');
    expect(first).toEqual({ key: 'name', direction: 'asc' });
    const second = nextSortState(first, 'name');
    expect(second).toEqual({ key: 'name', direction: 'desc' });
    // 🔴 解除できることが要る。既定の順序に意味がある一覧（監査ログは新しい順、
    // 部署は表示順）で、元へ戻せないと情報が失われる。
    expect(nextSortState(second, 'name')).toBeUndefined();
  });

  it('別の列を押したら、その列の昇順から始まる', () => {
    expect(nextSortState({ key: 'name', direction: 'desc' }, 'n')).toEqual({
      key: 'n',
      direction: 'asc',
    });
  });
});

describe('ariaSortFor', () => {
  it.each([
    [undefined, 'none'],
    [{ key: 'name', direction: 'asc' } as SortState, 'ascending'],
    [{ key: 'name', direction: 'desc' } as SortState, 'descending'],
  ])('%j のとき name 列は %s', (sort, expected) => {
    expect(ariaSortFor(sort, 'name')).toBe(expected);
  });

  it('下界: 他の列は none（並べ替え中の列以外に向きを出さない）', () => {
    expect(ariaSortFor({ key: 'name', direction: 'asc' }, 'n')).toBe('none');
  });
});
