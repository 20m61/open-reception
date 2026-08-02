import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOrganization, putOrganizationUnit } from './organization-repository';
import { __resetDirectory, createDepartment } from '@/lib/data-stores/directory-store';
import { getOrganizationView } from './organization-service';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
  vi.restoreAllMocks();
});

/**
 * 縮退経路（`/api/kiosk/directory`）向けの導出 (#597)。
 *
 * ## 塞ぎたい穴
 *
 * 縮退経路は #588 の判断で旧実装（組織モデルを読まない）のまま残していた。#373 増分 5/6 で
 * 編集経路が実在するようになった結果、**構成取得が落ちている間だけ、運用者が「来訪者に
 * 出さない」と設定した組織が再び出る**状態になった。fail-open であり、管理画面は
 * 「見えない」と表示しているので運用者からは気づけない。
 *
 * ## 残る fail-open は「組織の読み自体が落ちたとき」だけ
 *
 * そこで隠し続けようとすると「部署が 1 つも出ない受付端末」になり、受付そのものが止まる。
 * 範囲を狭めるのが目的で、ゼロにはできない。**縮退したことをログに残す**（黙って縮退すると
 * 誰も気づけない）。
 */
describe('getVisitorDirectoryForFallback (#597)', () => {
  it('通常時は「来訪者に出さない」設定が尊重される', async () => {
    const { getVisitorDirectoryForFallback } = await import('./organization-service');
    const dept = await createDepartment(T, { name: '内部監査室' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...unit, publicInDirectory: false });

    const directory = await getVisitorDirectoryForFallback(SCOPE);
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
  });

  it('通常時は公開表示名の編集も反映される', async () => {
    const { getVisitorDirectoryForFallback } = await import('./organization-service');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...unit, publicDisplayName: '営業（窓口）' });

    const directory = await getVisitorDirectoryForFallback(SCOPE);
    expect(directory.departments.find((d) => d.id === dept.value.id)?.name).toBe('営業（窓口）');
  });

  /**
   * **受付を止めない。** 組織の読みが落ちても、部署が 1 つも出ない受付端末にはしない。
   * ここで throw すると、実効構成も縮退経路も同時に落ちて来訪者が誰も選べなくなる。
   */
  it('組織コレクションの読みが落ちても、互換由来の部署は返る', async () => {
    const repo = await import('./organization-repository');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    vi.spyOn(repo, 'listOrganizationUnits').mockRejectedValue(new Error('read failed'));

    const { getVisitorDirectoryForFallback } = await import('./organization-service');
    const directory = await getVisitorDirectoryForFallback(SCOPE);
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(true);
  });

  /**
   * 縮退したことを**必ず記録する**。この状態は「隠したはずの組織が露出している」状態なので、
   * 黙って縮退すると誰も気づけないまま放置される。
   */
  it('縮退したらログに残す', async () => {
    const repo = await import('./organization-repository');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(repo, 'listOrganizationUnits').mockRejectedValue(new Error('read failed'));

    const { getVisitorDirectoryForFallback } = await import('./organization-service');
    await getVisitorDirectoryForFallback(SCOPE);
    expect(warn).toHaveBeenCalled();
  });
});
