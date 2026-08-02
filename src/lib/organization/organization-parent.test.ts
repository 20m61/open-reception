import { beforeEach, describe, expect, it } from 'vitest';
import { getOrganizationView, updateOrganizationUnit } from './organization-service';
import { __resetOrganization } from './organization-repository';
import { __resetDirectory, createDepartment } from '@/lib/data-stores/directory-store';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

async function dept(name: string): Promise<string> {
  const r = await createDepartment(T, { name });
  if (!r.ok) throw new Error('fixture failed');
  return r.value.id;
}

async function parentOf(id: string): Promise<string | undefined> {
  return (await getOrganizationView(SCOPE)).units.find((u) => u.id === id)?.parentId;
}

/**
 * 階層（親子）の編集 (#373 増分 7)。
 *
 * 判定は `canSetParent`（循環・深度上限・tenant/site 境界）に委ねる。ここで確かめるのは
 * **その判定が編集経路に実際に効いているか**。判定関数が在ることと、書き込みが通らないことは別。
 */
describe('updateOrganizationUnit / 親の付け替え', () => {
  it('親を設定できる', async () => {
    const parent = await dept('営業本部');
    const child = await dept('営業一課');

    const result = await updateOrganizationUnit(SCOPE, child, { parentId: parent });
    expect(result.ok).toBe(true);
    expect(await parentOf(child)).toBe(parent);
  });

  it('親を外せる（トップレベルへ戻す）', async () => {
    const parent = await dept('営業本部');
    const child = await dept('営業一課');
    await updateOrganizationUnit(SCOPE, child, { parentId: parent });

    const result = await updateOrganizationUnit(SCOPE, child, { parentId: null });
    expect(result.ok).toBe(true);
    expect(await parentOf(child)).toBeUndefined();
  });

  /**
   * **循環を作らせない。** 循環した階層は祖先を辿る処理（`ancestorsOf`）が終わらず、
   * 来訪者画面の描画ごと巻き込む。
   */
  it('自分を親にはできない', async () => {
    const id = await dept('営業部');
    const result = await updateOrganizationUnit(SCOPE, id, { parentId: id });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('invalid_input');
  });

  it('子孫を親にはできない（循環）', async () => {
    const parent = await dept('営業本部');
    const child = await dept('営業一課');
    await updateOrganizationUnit(SCOPE, child, { parentId: parent });

    const result = await updateOrganizationUnit(SCOPE, parent, { parentId: child });
    expect(result.ok).toBe(false);
    // 付け替えは行われていない。
    expect(await parentOf(parent)).toBeUndefined();
  });

  it('存在しない組織を親にはできない', async () => {
    const id = await dept('営業部');
    const result = await updateOrganizationUnit(SCOPE, id, { parentId: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('別テナントの組織を親にはできない（越境）', async () => {
    await __resetDirectory('acme');
    await __resetOrganization('acme');
    const mine = await dept('営業部');
    const otherDept = await createDepartment('acme', { name: '他社営業部' });
    if (!otherDept.ok) throw new Error('fixture failed');

    const result = await updateOrganizationUnit(SCOPE, mine, { parentId: otherDept.value.id });
    expect(result.ok).toBe(false);
    expect(await parentOf(mine)).toBeUndefined();
  });
});
