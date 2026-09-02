import { beforeEach, describe, expect, it } from 'vitest';
import { getOrganizationView, getVisitorDirectory, updateOrganizationUnit } from './organization-service';
import { __resetOrganization } from './organization-repository';
import { __resetDirectory, createDepartment } from '@/lib/data-stores/directory-store';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

/**
 * 組織の編集 (#373 増分 5)。
 *
 * **これが読み側の最初の生産者になる。** ここまでの増分（#588 / #590 / #592）は
 * 保存済み組織を読む経路を作ったが、本番に書き込み経路が無く観測可能な効果が無かった。
 */
describe('updateOrganizationUnit', () => {
  /**
   * 編集対象の大半は**まだ保存されていない互換組織**。保存済みだけを探すと
   * 「一覧に出ているのに編集できない」になる。
   */
  it('保存済みでない互換組織（Department 由来）も編集できる', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const result = await updateOrganizationUnit(SCOPE, dept.value.id, {
      publicDisplayName: '営業（お客さま窓口）',
    });

    expect(result.ok).toBe(true);
    const view = await getOrganizationView(SCOPE);
    expect(view.units.find((u) => u.id === dept.value.id)?.publicDisplayName).toBe(
      '営業（お客さま窓口）',
    );
  });

  /** 編集結果が**来訪者の画面まで**届くことが要点。届かなければ意味がない。 */
  it('編集した公開表示名が来訪者向けディレクトリに出る', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    await updateOrganizationUnit(SCOPE, dept.value.id, { publicDisplayName: '営業（窓口）' });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.find((d) => d.id === dept.value.id)?.name).toBe('営業（窓口）');
  });

  it('非公開にすると来訪者の一覧から消える', async () => {
    const dept = await createDepartment(T, { name: '内部監査室' });
    if (!dept.ok) throw new Error('fixture failed');

    await updateOrganizationUnit(SCOPE, dept.value.id, { publicInDirectory: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
  });

  it('並び順の編集が来訪者の並びに効く', async () => {
    const first = await createDepartment(T, { name: '営業部' });
    const second = await createDepartment(T, { name: '技術部' });
    if (!first.ok || !second.ok) throw new Error('fixture failed');

    await updateOrganizationUnit(SCOPE, second.value.id, { displayOrder: -1 });

    const ids = (await getVisitorDirectory(SCOPE)).departments.map((d) => d.id);
    expect(ids.indexOf(second.value.id)).toBeLessThan(ids.indexOf(first.value.id));
  });

  /**
   * 部分更新で他フィールドが消えないこと。`putOrganizationUnit` は置換なので、
   * patch だけを保存すると旧 UI 由来の名称などが飛ぶ。
   */
  it('部分更新で他のフィールドが消えない', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    await updateOrganizationUnit(SCOPE, dept.value.id, { publicDisplayName: '営業（窓口）' });
    await updateOrganizationUnit(SCOPE, dept.value.id, { displayOrder: 5 });

    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    expect(unit?.publicDisplayName).toBe('営業（窓口）');
    expect(unit?.displayOrder).toBe(5);
    expect(unit?.officialName).toBe('営業部');
  });

  it('存在しない組織は not_found', async () => {
    const result = await updateOrganizationUnit(SCOPE, 'nope', { publicDisplayName: 'x' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('not_found');
  });

  /**
   * **「在るが見えない」と「無い」を区別させない。** 区別できると、他テナントの組織 id の
   * 実在を当てられる（存在すれば 403 相当、しなければ 404 のような差）。
   */
  it('別テナントの組織 id も not_found（実在を漏らさない）', async () => {
    await __resetDirectory('acme');
    await __resetOrganization('acme');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const result = await updateOrganizationUnit(
      { kind: 'tenant', tenantId: 'acme' },
      dept.value.id,
      { publicDisplayName: 'x' },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('not_found');
  });

  it('空の公開表示名は拒否する（保存したのに出ない、を作らない）', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const result = await updateOrganizationUnit(SCOPE, dept.value.id, { publicDisplayName: '  ' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('invalid_input');
  });
});
