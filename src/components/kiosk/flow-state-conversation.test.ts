import { describe, expect, it } from 'vitest';
import { INITIAL, reducer } from './flow-state';

describe('APPLY_CONVERSATION (#1077)', () => {
  it('複数の既存遷移を1 reducer updateでconfirmingまでcoalesceする', () => {
    const next = reducer(INITIAL, {
      type: 'APPLY_CONVERSATION',
      actions: [
        { type: 'START' },
        { type: 'SELECT_PURPOSE', purpose: 'meeting' },
        {
          type: 'SELECT_TARGET',
          target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎', sublabel: '営業部' },
        },
        { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
      ],
    });

    expect(next).toMatchObject({
      state: 'confirming',
      purpose: 'meeting',
      target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
      visitor: { name: '張' },
    });
  });

  it('各stepは既存state machineを通るので順序不正ならそこで止まり、後続も進まない', () => {
    const next = reducer(INITIAL, {
      type: 'APPLY_CONVERSATION',
      actions: [
        // idle から SELECT_TARGET は不正。reducerは現状維持。
        { type: 'SELECT_TARGET', target: { type: 'staff', id: 's1', label: '鈴木' } },
        // 続く SUBMIT_VISITOR_INFO も idle では不正。
        { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
      ],
    });

    expect(next).toEqual(INITIAL);
  });

  it('batch自身にはCONFIRMを持てず、confirming到達後も呼び出しは開始しない', () => {
    const confirming = reducer(INITIAL, {
      type: 'APPLY_CONVERSATION',
      actions: [
        { type: 'START' },
        { type: 'SELECT_PURPOSE', purpose: 'meeting' },
        { type: 'SELECT_TARGET', target: { type: 'department', id: 'sales', label: '営業部' } },
        { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
      ],
    });

    expect(confirming.state).toBe('confirming');
    // 発信は従来の明示操作だけ。
    expect(reducer(confirming, { type: 'CONFIRM' }).state).toBe('calling');
  });
});
