import { describe, expect, it, vi } from 'vitest';

// PlatformLayout（デフォルトエクスポート）は認可解決・cookie 等の実行時コンテキストを要するため、
// ここでは純粋関数 resolvePlatformTitle のみを対象にする。
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }));
vi.mock('@/components/admin/AdminShell', () => ({ AdminShell: () => null }));
vi.mock('@/components/admin/platform/ElevationStatus', () => ({ ElevationStatus: () => null }));
vi.mock('@/components/admin/platform/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('@/lib/auth/actor', () => ({ resolveAdminActorWithIdentity: vi.fn() }));
vi.mock('@/domain/auth/route-guard', () => ({ canEnterArea: vi.fn() }));
vi.mock('@/lib/platform/elevation', () => ({ ELEVATION_COOKIE: 'x', readElevation: vi.fn() }));
vi.mock('@/lib/platform/elevation-jti-store', () => ({ elevationJtiState: vi.fn() }));
vi.mock('@/proxy', () => ({ PATHNAME_HEADER: 'x-pathname' }));

import { resolvePlatformTitle } from './layout';
import { PLATFORM_NAV } from '@/components/admin/navigation';

describe('resolvePlatformTitle: 運用コンソールのタブタイトル解決 (#331)', () => {
  it('/platform はダッシュボード（ルートインデックスは完全一致のみ）', () => {
    expect(resolvePlatformTitle('/platform')).toBe('ダッシュボード');
  });

  it.each(PLATFORM_NAV.flatMap((g) => g.items).filter((i) => i.href !== '/platform'))(
    '$href は PLATFORM_NAV のラベル $label に解決される',
    ({ href, label }) => {
      expect(resolvePlatformTitle(href)).toBe(label);
      expect(resolvePlatformTitle(`${href}/detail`)).toBe(label);
    },
  );

  it('未知のパスは既定文言「運用コンソール」にフォールバックする', () => {
    expect(resolvePlatformTitle('/platform/does-not-exist')).toBe('運用コンソール');
  });
});
