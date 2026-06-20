import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDirectory, getStaff, updateStaff } from './directory-store';
import { normalizeCallTargets } from '@/domain/staff/types';

beforeEach(async () => {
  await __resetDirectory();
});

describe('normalizeCallTargets (#26)', () => {
  it('配列順を priority に再採番し、不正値を除去する', () => {
    const result = normalizeCallTargets([
      { type: 'email', value: 'a@example.com' },
      { type: 'bogus', value: 'x' },
      { type: 'phone', value: '' },
      { type: 'vonage', value: 's1', enabled: false },
    ]);
    expect(result.map((t) => [t.type, t.priority])).toEqual([
      ['email', 0],
      ['vonage', 1],
    ]);
    expect(result[1]?.enabled).toBe(false);
  });
});

describe('updateStaff call targets / fallback (#26)', () => {
  it('呼び出し先を設定し優先順位を採番する', async () => {
    await updateStaff('staff-suzuki', {
      callTargets: [
        { type: 'phone', value: '03-0000-0000' },
        { type: 'slack', value: '#hanako' },
      ],
    });
    const s = await getStaff('staff-suzuki');
    if (!s.ok) throw new Error('not found');
    expect(s.value.callTargets.map((t) => t.priority)).toEqual([0, 1]);
  });

  it('DnD 並び替え（配列順）を反映する', async () => {
    await updateStaff('staff-suzuki', { callTargets: [{ type: 'email', value: 'b' }, { type: 'phone', value: 'a' }] });
    await updateStaff('staff-suzuki', { callTargets: [{ type: 'phone', value: 'a' }, { type: 'email', value: 'b' }] });
    const s = await getStaff('staff-suzuki');
    if (s.ok) expect(s.value.callTargets[0]?.type).toBe('phone');
  });

  it('代替担当者は存在する他担当者のみ受け付ける（自分・不明は除外）', async () => {
    await updateStaff('staff-sato', { fallbackStaffIds: ['staff-tanaka', 'staff-sato', 'unknown'] });
    const s = await getStaff('staff-sato');
    if (s.ok) expect(s.value.fallbackStaffIds).toEqual(['staff-tanaka']);
  });
});
