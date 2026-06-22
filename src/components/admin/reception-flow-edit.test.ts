import { describe, expect, it } from 'vitest';
import {
  buildFieldDraft,
  isFieldFormReady,
  parseOptionsInput,
  reorderBySwap,
} from './reception-flow-edit';

type Row = { id: string; order: number };
const rows: Row[] = [
  { id: 'a', order: 0 },
  { id: 'b', order: 1 },
  { id: 'c', order: 2 },
];

describe('reorderBySwap', () => {
  it('下へ移動すると隣と入れ替わり、変わった項目だけ changed に入る', () => {
    const { items, changed } = reorderBySwap(rows, 0, 1);
    expect(items.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(items.map((r) => r.order)).toEqual([0, 1, 2]);
    expect(changed).toEqual([
      { id: 'b', order: 0 },
      { id: 'a', order: 1 },
    ]);
  });

  it('上へ移動も対称に動く', () => {
    const { items, changed } = reorderBySwap(rows, 2, -1);
    expect(items.map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(changed.map((c) => c.id).sort()).toEqual(['b', 'c']);
  });

  it('端を越える移動は何もしない（changed 空・非破壊）', () => {
    expect(reorderBySwap(rows, 0, -1).changed).toEqual([]);
    expect(reorderBySwap(rows, 2, 1).changed).toEqual([]);
    // 入力配列は変更されない。
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('parseOptionsInput', () => {
  it('カンマ/改行区切りを正規化し、空要素と前後空白を除く', () => {
    expect(parseOptionsInput('面接, 説明会\n 会社見学 ,')).toEqual(['面接', '説明会', '会社見学']);
  });

  it('空文字は空配列', () => {
    expect(parseOptionsInput('   ')).toEqual([]);
  });
});

describe('buildFieldDraft', () => {
  it('text は options を付けず key/label を trim する', () => {
    expect(
      buildFieldDraft({ key: ' visitor-name ', label: ' お名前 ', type: 'text', required: true }),
    ).toEqual({ key: 'visitor-name', label: 'お名前', type: 'text', required: true });
  });

  it('select は選択肢を options に展開する', () => {
    expect(
      buildFieldDraft({
        key: 'slot',
        label: '希望枠',
        type: 'select',
        required: false,
        optionsInput: '午前, 午後',
      }),
    ).toEqual({ key: 'slot', label: '希望枠', type: 'select', required: false, options: ['午前', '午後'] });
  });
});

describe('isFieldFormReady', () => {
  it('key/label がそろえば true（text）', () => {
    expect(isFieldFormReady({ key: 'x', label: 'ラベル', type: 'text', required: false })).toBe(true);
  });

  it('key か label が空なら false', () => {
    expect(isFieldFormReady({ key: '', label: 'ラベル', type: 'text', required: false })).toBe(false);
    expect(isFieldFormReady({ key: 'x', label: ' ', type: 'text', required: false })).toBe(false);
  });

  it('select は選択肢が無いと false', () => {
    expect(isFieldFormReady({ key: 'x', label: 'L', type: 'select', required: false, optionsInput: '' })).toBe(
      false,
    );
    expect(
      isFieldFormReady({ key: 'x', label: 'L', type: 'select', required: false, optionsInput: 'A,B' }),
    ).toBe(true);
  });
});
