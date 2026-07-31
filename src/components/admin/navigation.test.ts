import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@/domain/tenant/types';
import {
  ADMIN_NAV,
  PLATFORM_NAV,
  UNLISTED_ADMIN_ROUTES,
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

  it('サイドバー（240px）で 1 行に収まる長さにラベルを抑える（#330 item4 の回帰防止）', () => {
    // nav-link-style.ts が font.body（0.95rem=15.2px）+ keep-all を使う前提で、
    // サイドバー内側の使用可能幅（240 - padding(24*2) - リンク padding(10*2) ≒ 172px）に
    // 収まる目安として 10 文字を上限にする。これを超えるラベルは折り返しやすくなる。
    const MAX_LABEL_LENGTH = 10;
    for (const nav of [ADMIN_NAV, PLATFORM_NAV]) {
      for (const group of nav) {
        for (const item of group.items) {
          expect(item.label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
        }
      }
    }
  });
});

/**
 * **作った画面がナビから辿れないまま放置されるのを止める** (issue #421)。
 *
 * `/admin/experience-versions` は第 21 wave（#420）で作ったが、`ADMIN_NAV` にも他画面からの
 * リンクにも登録されず、**URL を直接打つ以外に開く手段が無い**状態で放置されていた。
 * ナビへの登録は「画面を作った周回」と「IA を触る周回」が別なので、規律では抜ける。
 *
 * ここでは `src/app/admin/**` の実ルートを走査し、ナビに載っているか、載せない理由を
 * `UNLISTED_ADMIN_ROUTES` に登録してあるかのどちらかを強制する。
 */
describe('管理画面のルートはナビから辿れる', () => {
  const routeDirs = readdirSync('src/app/admin', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `/admin/${e.name}`)
    .filter((href) => existsSync(`src/app${href}/page.tsx`));

  it('全ルートがナビ登録済みか、理由付きで非掲載登録されている', () => {
    const listed = new Set(ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href)));
    const unlisted = new Set(Object.keys(UNLISTED_ADMIN_ROUTES));
    const orphans = routeDirs.filter((href) => !listed.has(href) && !unlisted.has(href));
    expect(orphans, `ナビから辿れない画面: ${orphans.join(', ')}`).toEqual([]);
  });

  it('非掲載の理由が空文字で誤魔化されていない', () => {
    for (const [href, reason] of Object.entries(UNLISTED_ADMIN_ROUTES)) {
      expect(reason.length, `${href} の非掲載理由`).toBeGreaterThan(10);
    }
  });

  it('非掲載リストに実在しないルートが残っていない（消したのに残る、を防ぐ）', () => {
    for (const href of Object.keys(UNLISTED_ADMIN_ROUTES)) {
      expect(routeDirs, `${href} は実在しない`).toContain(href);
    }
  });
});

describe('重複ナビの一本化 (#421)', () => {
  const adminHrefs = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href));

  it('受付端末はナビに 1 つだけ（devices を正とする）', () => {
    // `docs/site-device-management-design.md` の確定方針: Device を正とし、
    // /admin/devices を主管理画面、/admin/kiosks は旧 token フロー互換で当面残す。
    // ナビにも「受付端末」「受付端末（拠点別）」と対等に 2 つ並んでいたのが方針との乖離。
    expect(adminHrefs).toContain('/admin/devices');
    expect(adminHrefs).not.toContain('/admin/kiosks');
  });

  it('取次はナビに 1 つだけ（call-routing を正とする）', () => {
    // `CallRoute`(#88) は **実際の発信が参照しない**（発信は executeRoutedCall →
    // RoutingPolicy/ContactEndpoint #374。routing/compat.ts は消費者ゼロ）。
    // 「呼び出しルート」を設定しても実通話に効かないので、対等に並べると誤解を生む。
    expect(adminHrefs).toContain('/admin/call-routing');
    expect(adminHrefs).not.toContain('/admin/call-routes');
  });

  it('ナビから外した旧画面は理由付きで非掲載登録する（消しはしない）', () => {
    // 受付フローの callRouteId が旧 CallRoute を参照しており、kiosks も token 発行フローが
    // 生きている。**消すのではなく legacy 表示へ寄せる**（#421 AC の段階廃止）。
    expect(Object.keys(UNLISTED_ADMIN_ROUTES)).toEqual(
      expect.arrayContaining(['/admin/kiosks', '/admin/call-routes']),
    );
  });
});
