import { describe, expect, it } from 'vitest';
import { mergeOrganizationMemberships } from './compat';
import type { OrganizationMembership } from './types';

/**
 * 互換所属と保存済み所属の合成 (#373 増分 3)。
 *
 * `mergeOrganizationUnits` と同じ原則を所属にも適用する:
 * **「無効化・非公開は fail-closed で AND、編集結果は保存済みが勝つ」**。
 */

function m(patch: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {
    staffId: 'staff-1',
    organizationId: 'org-1',
    relation: 'primary',
    publicInDirectory: true,
    callable: true,
    ...patch,
  };
}

describe('mergeOrganizationMemberships', () => {
  it('保存済みのみ・互換のみはそのまま残る', () => {
    expect(mergeOrganizationMemberships([m()], [])).toHaveLength(1);
    expect(mergeOrganizationMemberships([], [m()])).toHaveLength(1);
  });

  it('同じ staff × 組織は 1 件に合成される', () => {
    const merged = mergeOrganizationMemberships([m()], [m({ relation: 'acting' })]);
    expect(merged).toHaveLength(1);
  });

  it('編集結果（relation）は保存済みが勝つ', () => {
    const merged = mergeOrganizationMemberships(
      [m({ relation: 'primary' })],
      [m({ relation: 'acting', actingForStaffId: 'staff-9' })],
    );
    expect(merged[0]?.relation).toBe('acting');
    expect(merged[0]?.actingForStaffId).toBe('staff-9');
  });

  /**
   * **閉じる方向は必ず効く。** stored が丸ごと置換すると、一度でも新 UI で所属を編集した
   * 担当者は、既存の担当者管理 UI で呼び出し不可にしても**呼べたまま**になる。
   */
  it('callable は AND（旧 UI で閉じても効く）', () => {
    expect(
      mergeOrganizationMemberships([m({ callable: false })], [m({ callable: true })])[0]?.callable,
    ).toBe(false);
  });

  it('callable は AND（新 UI で閉じても効く）', () => {
    expect(
      mergeOrganizationMemberships([m({ callable: true })], [m({ callable: false })])[0]?.callable,
    ).toBe(false);
  });

  it('publicInDirectory も同じく AND', () => {
    expect(
      mergeOrganizationMemberships(
        [m({ publicInDirectory: false })],
        [m({ publicInDirectory: true })],
      )[0]?.publicInDirectory,
    ).toBe(false);
  });

  it('両方が開いているときだけ開く', () => {
    const merged = mergeOrganizationMemberships([m()], [m()]);
    expect(merged[0]?.callable).toBe(true);
    expect(merged[0]?.publicInDirectory).toBe(true);
  });

  it('兼務（同じ staff の別組織）は別件として残る', () => {
    const merged = mergeOrganizationMemberships(
      [m({ organizationId: 'org-1' })],
      [m({ organizationId: 'org-2', relation: 'secondary' })],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * 複合キーを素朴に連結すると別の組へ化ける（`membership-key.ts` と同じ懸念）。
   * 合成でも同一性判定を誤らないことを固定する。
   */
  it('区切り文字を含む id でも別の組と混ざらない', () => {
    const merged = mergeOrganizationMemberships(
      [m({ staffId: 'a', organizationId: 'b:c' })],
      [m({ staffId: 'a:b', organizationId: 'c', callable: false })],
    );
    expect(merged).toHaveLength(2);
    // 互換側（a / b:c）は閉じられていない。
    expect(merged.find((x) => x.staffId === 'a')?.callable).toBe(true);
  });
});
