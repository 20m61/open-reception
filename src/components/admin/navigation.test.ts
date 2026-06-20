import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/domain/tenant/types';
import {
  ADMIN_NAV,
  PLATFORM_NAV,
  type NavGroup,
  isActivePath,
  visibleNav,
} from './navigation';

describe('visibleNav: ロールに応じた出し分け (#85)', () => {
  it('developer は admin の全グループ・全項目を順序通り見られる', () => {
    const groups = visibleNav(ADMIN_NAV, ['developer']);
    // 全グループが定義順で残る
    expect(groups.map((g) => g.id)).toEqual(ADMIN_NAV.map((g) => g.id));
    // 各グループの項目も全て残る
    for (const g of groups) {
      const src = ADMIN_NAV.find((x) => x.id === g.id);
      expect(g.items.map((i) => i.href)).toEqual(src?.items.map((i) => i.href));
    }
  });

  it('viewer は experience グループ（tenant_admin 限定）を見られない', () => {
    const groups = visibleNav(ADMIN_NAV, ['viewer']);
    expect(groups.map((g) => g.id)).not.toContain('experience');
    expect(groups.map((g) => g.id)).toContain('operations');
  });

  it('viewer は governance 内の security 項目を見られないが audit は見られる', () => {
    const groups = visibleNav(ADMIN_NAV, ['viewer']);
    const governance = groups.find((g) => g.id === 'governance');
    expect(governance).toBeDefined();
    const hrefs = governance?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain('/admin/audit');
    expect(hrefs).not.toContain('/admin/security');
  });

  it('kiosk_device は admin ナビを一切見られない', () => {
    expect(visibleNav(ADMIN_NAV, ['kiosk_device'])).toEqual([]);
  });

  it('platform ナビは developer のみ。テナントロールでは空', () => {
    expect(visibleNav(PLATFORM_NAV, ['developer']).length).toBeGreaterThan(0);
    for (const role of ['tenant_admin', 'site_manager', 'viewer', 'kiosk_device'] as TenantRole[]) {
      expect(visibleNav(PLATFORM_NAV, [role])).toEqual([]);
    }
  });

  it('項目が 0 になったグループは除外される', () => {
    const nav: NavGroup[] = [
      {
        id: 'g',
        label: 'g',
        roles: ['developer', 'viewer'],
        items: [{ href: '/x', label: 'x', roles: ['developer'] }],
      },
    ];
    // viewer はグループは見えるが、唯一の項目が developer 限定 → グループごと除外
    expect(visibleNav(nav, ['viewer'])).toEqual([]);
    expect(visibleNav(nav, ['developer']).length).toBe(1);
  });

  it('複数ロールはいずれか一致すれば表示（和集合）', () => {
    const groups = visibleNav(ADMIN_NAV, ['viewer', 'tenant_admin']);
    expect(groups.map((g) => g.id)).toContain('experience');
  });

  it('拠点（sites）は日常運用グループにあり viewer も閲覧できる (#87)', () => {
    const groups = visibleNav(ADMIN_NAV, ['viewer']);
    const ops = groups.find((g) => g.id === 'operations');
    expect(ops?.items.map((i) => i.href)).toContain('/admin/sites');
  });
});

describe('isActivePath: 現在地判定 (#85)', () => {
  it.each<[string, string, boolean]>([
    ['/admin', '/admin', true],
    ['/admin', '/admin/staff', false], // ルートインデックスは配下で点灯しない
    ['/admin/staff', '/admin/staff', true],
    ['/admin/staff', '/admin/staff/123', true], // 配下パスは点灯
    ['/admin/staff', '/admin/staffroom', false], // 前方一致だが別ルートは点灯しない
    ['/platform', '/platform', true],
    ['/platform', '/platform/tenants', false],
    ['/platform/tenants', '/platform/tenants', true],
  ])('isActivePath(%s, %s) = %s', (href, pathname, expected) => {
    expect(isActivePath(href, pathname)).toBe(expected);
  });
});

describe('IA 定義の不変条件 (#85)', () => {
  it('admin/platform で href が一意である', () => {
    for (const nav of [ADMIN_NAV, PLATFORM_NAV]) {
      const hrefs = nav.flatMap((g) => g.items.map((i) => i.href));
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });

  it('platform の破壊的導線は danger フラグを持つ', () => {
    const dangerHrefs = PLATFORM_NAV.flatMap((g) => g.items)
      .filter((i) => i.danger)
      .map((i) => i.href);
    expect(dangerHrefs).toContain('/platform/tenants');
    expect(dangerHrefs).toContain('/platform/maintenance');
  });
});
