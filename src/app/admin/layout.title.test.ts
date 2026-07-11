import { describe, expect, it, vi } from 'vitest';

// AdminLayout（デフォルトエクスポート）は next/navigation の redirect 等、実行に
// リクエストコンテキストを要するため、ここでは純粋関数 resolveAdminTitle のみを対象にする。
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/components/admin/AdminShell', () => ({ AdminShell: () => null }));
vi.mock('@/components/admin/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: vi.fn() }));
vi.mock('@/lib/tenant/active-tenant', () => ({ resolveActiveTenant: vi.fn() }));
vi.mock('@/domain/auth/route-guard', () => ({ canEnterArea: vi.fn() }));
vi.mock('@/proxy', () => ({ PATHNAME_HEADER: 'x-pathname' }));

import { resolveAdminTitle } from './layout';
import { ADMIN_NAV } from '@/components/admin/navigation';

describe('resolveAdminTitle: 管理画面のタブタイトル解決 (#331)', () => {
  it('/admin はダッシュボード（ルートインデックスは完全一致のみ）', () => {
    expect(resolveAdminTitle('/admin')).toBe('ダッシュボード');
  });

  it('/admin/login はログイン', () => {
    expect(resolveAdminTitle('/admin/login')).toBe('ログイン');
  });

  it.each(ADMIN_NAV.flatMap((g) => g.items).filter((i) => i.href !== '/admin'))(
    '$href は ADMIN_NAV のラベル $label に解決される',
    ({ href, label }) => {
      expect(resolveAdminTitle(href)).toBe(label);
      // 配下パスも同じ項目に解決される（最長一致）。
      expect(resolveAdminTitle(`${href}/detail`)).toBe(label);
    },
  );

  it('未知のパスは既定文言「管理画面」にフォールバックする', () => {
    expect(resolveAdminTitle('/admin/does-not-exist')).toBe('管理画面');
    expect(resolveAdminTitle('')).toBe('管理画面');
  });
});
