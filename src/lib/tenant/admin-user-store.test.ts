/**
 * AdminUser 永続化ストアの単体テスト (#80 increment 2)。
 * memory バックエンド（DATA_BACKEND 未設定）で round-trip と subject/email 解決、seed を検証する。
 * DynamoDB 実装は data backend 抽象（dynamodb.test.ts）で別途担保する流儀に倣う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asAdminUserId, type AdminUser } from '@/domain/tenant/types';
import { __resetBackend } from '@/lib/data';

const now = '2026-06-20T00:00:00.000Z';

function makeUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: asAdminUserId('u1'),
    entraSubject: 'oid-1',
    email: 'User@Example.com',
    displayName: 'User',
    assignments: [{ role: 'tenant_admin', tenantId: 'acme' as never, siteId: null, deviceId: null }],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('DataBackedAdminUserRepository (memory backend)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OPEN_RECEPTION_ADMIN_SEED_SUBJECT;
    delete process.env.OPEN_RECEPTION_ADMIN_SEED_EMAIL;
    __resetBackend();
  });
  afterEach(() => {
    __resetBackend();
  });

  it('put/get round-trips through getBackend', async () => {
    const { getAdminUserRepository } = await import('./admin-user-store');
    const repo = getAdminUserRepository();
    await repo.putAdminUser(makeUser());
    expect(await repo.getAdminUser(asAdminUserId('u1'))).toMatchObject({ id: 'u1' });
  });

  it('findBySubject resolves by Entra subject', async () => {
    const { getAdminUserRepository } = await import('./admin-user-store');
    const repo = getAdminUserRepository();
    await repo.putAdminUser(makeUser({ entraSubject: 'oid-xyz' }));
    expect(await repo.findBySubject('oid-xyz')).toMatchObject({ id: 'u1' });
    expect(await repo.findBySubject('missing')).toBeUndefined();
    expect(await repo.findBySubject('')).toBeUndefined();
  });

  it('findByEmail is case-insensitive and ignores blank', async () => {
    const { getAdminUserRepository } = await import('./admin-user-store');
    const repo = getAdminUserRepository();
    await repo.putAdminUser(makeUser({ email: 'Mixed@Case.COM' }));
    expect(await repo.findByEmail('mixed@case.com')).toMatchObject({ id: 'u1' });
    expect(await repo.findByEmail('  ')).toBeUndefined();
    expect(await repo.findByEmail('nope@x.com')).toBeUndefined();
  });

  it('seeds an internal tenant_admin; subject seeded only when env set', async () => {
    // 既定 seed（subject なし）。
    {
      const { getAdminUserRepository } = await import('./admin-user-store');
      const seeded = await getAdminUserRepository().getAdminUser(asAdminUserId('admin-seed'));
      expect(seeded?.assignments[0]?.role).toBe('tenant_admin');
      expect(seeded?.entraSubject).toBeUndefined();
    }
    // subject env を与えると seed ユーザーに紐づく。
    vi.resetModules();
    __resetBackend();
    process.env.OPEN_RECEPTION_ADMIN_SEED_SUBJECT = 'oid-seed';
    {
      const { getAdminUserRepository } = await import('./admin-user-store');
      const found = await getAdminUserRepository().findBySubject('oid-seed');
      expect(found?.id).toBe('admin-seed');
    }
  });
});
