import { describe, expect, it } from 'vitest';
import { validateOrganizationUnitPatch } from './update';

/**
 * 組織の編集入力の検証 (#373 増分 5)。
 *
 * ここを緩くすると、来訪者面の読み側が fail-closed で握り潰すことになる（公開表示名が
 * 空の組織は `publicUnitsInScope` が落とす）。**運用者から見ると「保存したのに出ない」**
 * という最悪の形になるので、書き込み時に弾く。
 */
describe('validateOrganizationUnitPatch', () => {
  it('オブジェクトでなければ拒否する', () => {
    expect(validateOrganizationUnitPatch(null).ok).toBe(false);
    expect(validateOrganizationUnitPatch('x').ok).toBe(false);
  });

  it('指定したフィールドだけを返す（未指定は触らない）', () => {
    const r = validateOrganizationUnitPatch({ publicDisplayName: '営業（窓口）' });
    expect(r.ok && r.value).toEqual({ publicDisplayName: '営業（窓口）' });
  });

  /** 空の公開表示名は読み側が落とすので、書き込みで弾く。 */
  it('公開表示名が空・空白のみなら拒否する', () => {
    expect(validateOrganizationUnitPatch({ publicDisplayName: '' }).ok).toBe(false);
    expect(validateOrganizationUnitPatch({ publicDisplayName: '   ' }).ok).toBe(false);
  });

  it('公開表示名の前後空白は落とす', () => {
    const r = validateOrganizationUnitPatch({ publicDisplayName: '  営業部  ' });
    expect(r.ok && r.value.publicDisplayName).toBe('営業部');
  });

  it('displayOrder は数値のみ受ける', () => {
    expect(validateOrganizationUnitPatch({ displayOrder: 3 }).ok).toBe(true);
    expect(validateOrganizationUnitPatch({ displayOrder: '3' }).ok).toBe(false);
    expect(validateOrganizationUnitPatch({ displayOrder: Number.NaN }).ok).toBe(false);
  });

  it('publicInDirectory は真偽値のみ受ける', () => {
    expect(validateOrganizationUnitPatch({ publicInDirectory: false }).ok).toBe(true);
    expect(validateOrganizationUnitPatch({ publicInDirectory: 'no' }).ok).toBe(false);
  });

  /**
   * **id / tenantId は編集させない。** 書き換えられると別テナントの組織を作れてしまう。
   * 黙って無視せず拒否する（送ったのに効かない方が危険）。
   */
  it('id・tenantId を含む入力は拒否する', () => {
    expect(validateOrganizationUnitPatch({ id: 'x' }).ok).toBe(false);
    expect(validateOrganizationUnitPatch({ tenantId: 'other' }).ok).toBe(false);
  });

  /**
   * `parentId` はここでは**形だけ**を見る (#373 増分 7)。循環・深度上限・tenant/site 境界は
   * 他の組織との関係が要るので純粋な入力検証では決められない（`canSetParent` が行う）。
   */
  it('parentId は文字列か null を受ける', () => {
    expect(validateOrganizationUnitPatch({ parentId: 'org-1' }).ok).toBe(true);
    expect(validateOrganizationUnitPatch({ parentId: null }).ok).toBe(true);
  });

  /** `null`（外す）と `undefined`（触らない）を同一視しない。空文字は id として不正。 */
  it('parentId が空文字・数値なら拒否する', () => {
    expect(validateOrganizationUnitPatch({ parentId: '' }).ok).toBe(false);
    expect(validateOrganizationUnitPatch({ parentId: '  ' }).ok).toBe(false);
    expect(validateOrganizationUnitPatch({ parentId: 1 }).ok).toBe(false);
  });

  it('parentId: null は「外す」として値に残る（キー欠落と区別する）', () => {
    const r = validateOrganizationUnitPatch({ parentId: null });
    expect(r.ok && 'parentId' in r.value).toBe(true);
    expect(r.ok && r.value.parentId).toBeNull();
  });

  it('編集対象が 1 つも無ければ拒否する（無音の成功を作らない）', () => {
    expect(validateOrganizationUnitPatch({}).ok).toBe(false);
  });
});
