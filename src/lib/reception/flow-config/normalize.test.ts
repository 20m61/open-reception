import { describe, expect, it } from 'vitest';
import { stripRetiredFlowFields } from './normalize';

describe('stripRetiredFlowFields: 撤去済みフィールドを実行時に落とす (#421)', () => {
  it('保存済みレコードの callRouteId を落とす', () => {
    // **型から消しても実行時のオブジェクトからは消えない。** リポジトリは保存済みレコードを
    // そのまま返し、`flowResponse` がそのまま直列化するので、撤去したはずの
    // `callRouteId` が admin / kiosk の応答に出続ける（#549 レビュー P2）。
    const stored = { id: 'f1', displayName: '面接', callRouteId: 'route-1' };
    expect(stripRetiredFlowFields(stored)).toEqual({ id: 'f1', displayName: '面接' });
  });

  it('持っていないレコードはそのまま返す（同一参照）', () => {
    // 大多数のレコードは既に持っていない。無駄なコピーを作らない。
    const stored = { id: 'f1', displayName: '面接' };
    expect(stripRetiredFlowFields(stored)).toBe(stored);
  });

  it('他のフィールドは一切変えない', () => {
    const stored = {
      id: 'f1',
      displayName: '面接',
      order: 3,
      enabled: false,
      fields: [{ key: 'name' }],
      callRouteId: 'route-1',
    };
    const out = stripRetiredFlowFields(stored) as typeof stored;
    expect(out.order).toBe(3);
    expect(out.enabled).toBe(false);
    expect(out.fields).toEqual([{ key: 'name' }]);
  });

  it('undefined を持っていても落とす（キー自体を消す）', () => {
    const stored = { id: 'f1', callRouteId: undefined };
    expect(Object.keys(stripRetiredFlowFields(stored))).toEqual(['id']);
  });
});
