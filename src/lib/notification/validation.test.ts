import { describe, expect, it } from 'vitest';
import { validateGroup, validateGroups, validateRouteName, validateTarget } from './validation';

describe('validateRouteName (#88)', () => {
  it('前後空白を除去して返す', () => {
    const r = validateRouteName('  本社ルート  ');
    expect(r.ok && r.value).toBe('本社ルート');
  });
  it('空文字は invalid_input', () => {
    expect(validateRouteName('   ').ok).toBe(false);
  });
  it('非文字列は invalid_input', () => {
    expect(validateRouteName(123).ok).toBe(false);
  });
  it('長すぎる名前は invalid_input', () => {
    expect(validateRouteName('x'.repeat(121)).ok).toBe(false);
  });
});

describe('validateTarget (#88)', () => {
  it('有効な電話ターゲットを正規化する', () => {
    const r = validateTarget({ label: ' 代表 ', channel: 'phone', value: ' +81300000000 ', priority: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ label: '代表', channel: 'phone', value: '+81300000000', priority: 1 });
  });
  it('priority 未指定は 0 になる', () => {
    const r = validateTarget({ label: 'x', channel: 'email', value: 'a@b.c' });
    expect(r.ok && r.value.priority).toBe(0);
  });
  it('不正なチャネルは拒否', () => {
    expect(validateTarget({ label: 'x', channel: 'fax', value: '1' }).ok).toBe(false);
  });
  it('空の value は拒否', () => {
    expect(validateTarget({ label: 'x', channel: 'phone', value: '  ' }).ok).toBe(false);
  });
  it('負の priority は拒否', () => {
    expect(validateTarget({ label: 'x', channel: 'phone', value: '1', priority: -1 }).ok).toBe(false);
  });
});

describe('validateGroup / validateGroups (#88)', () => {
  it('グループとターゲットを検証する', () => {
    const r = validateGroup({
      label: ' 総務 ',
      targets: [{ label: '代表', channel: 'phone', value: '+81', priority: 0 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBe('総務');
  });
  it('targets が配列でなければ拒否', () => {
    expect(validateGroup({ label: 'g', targets: 'x' }).ok).toBe(false);
  });
  it('groups 未指定は空配列を許容', () => {
    const r = validateGroups(undefined);
    expect(r.ok && r.value).toEqual([]);
  });
  it('1 件でも不正なグループがあれば全体を拒否', () => {
    const r = validateGroups([
      { label: 'ok', targets: [] },
      { label: '', targets: [] },
    ]);
    expect(r.ok).toBe(false);
  });
});
