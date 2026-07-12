import { describe, expect, it } from 'vitest';
import { csvCell, jstEndBoundary, jstStartBoundary, paginate, toCsv } from './list-io';

describe('paginate: 一覧の共通ページング純関数 (issue #330 item2 残増分)', () => {
  it('ページサイズで分割し、指定ページの要素だけ返す', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const page1 = paginate(items, 1, 10);
    expect(page1.items).toEqual(items.slice(0, 10));
    expect(page1.page).toBe(1);
    expect(page1.pageCount).toBe(3);
    expect(page1.total).toBe(25);

    const page3 = paginate(items, 3, 10);
    expect(page3.items).toEqual(items.slice(20, 25));
  });

  it('範囲外のページ番号は有効範囲へクランプする', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, -3, 10).page).toBe(1);
    expect(paginate(items, 99, 10).page).toBe(1);
    expect(paginate(items, Number.NaN, 10).page).toBe(1);
  });

  it('空配列でも 0 除算せず pageCount は最低 1', () => {
    const page = paginate([], 1, 10);
    expect(page.items).toEqual([]);
    expect(page.pageCount).toBe(1);
    expect(page.total).toBe(0);
  });
});

describe('jstStartBoundary / jstEndBoundary: JST 暦日の境界解釈 (#254 と同方針)', () => {
  it('date-only は JST 00:00 を下限にする', () => {
    // 2026-07-01T00:00:00+09:00 = 2026-06-30T15:00:00Z
    expect(jstStartBoundary('2026-07-01')).toBe(Date.parse('2026-06-30T15:00:00.000Z'));
  });

  it('date-only は JST 23:59:59.999 を上限にする', () => {
    expect(jstEndBoundary('2026-07-01')).toBe(Date.parse('2026-07-01T14:59:59.999Z'));
  });

  it('時刻付き ISO はその瞬間をそのまま境界にする', () => {
    const iso = '2026-07-01T03:00:00.000Z';
    expect(jstStartBoundary(iso)).toBe(Date.parse(iso));
    expect(jstEndBoundary(iso)).toBe(Date.parse(iso));
  });
});

describe('csvCell / toCsv: CSV セルエスケープ + 数式インジェクション無害化', () => {
  it('カンマ・改行・ダブルクォートを含む値のみクォートする', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('=/+/@ で始まる自由入力セルは先頭タブで無害化する', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe('\t=SUM(A1:A2)');
    expect(csvCell('+81-3-1234')).toBe('\t+81-3-1234');
    expect(csvCell('@evil')).toBe('\t@evil');
  });

  it('単独ハイフンや数値プレフィックスの - は式とみなさない', () => {
    expect(csvCell('-')).toBe('-');
    expect(csvCell('-123')).toBe('-123');
  });

  it('- の後に式が続く場合は無害化する', () => {
    expect(csvCell('-cmd|calc')).toBe('\t-cmd|calc');
  });

  it('toCsv はヘッダ + 行を CSV（末尾改行付き）に組み立てる', () => {
    const csv = toCsv(['a', 'b'], [['1', '2'], ['x,y', 'z']]);
    expect(csv).toBe('a,b\n1,2\n"x,y",z\n');
  });
});
