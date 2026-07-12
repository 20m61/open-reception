/**
 * TenantLimitsRepository の契約テスト (issue #313)。
 * memory backend（DATA_BACKEND 既定）で get/put/reset の round-trip を固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { __resetBackend } from '@/lib/data';
import { DataBackedTenantLimitsRepository } from './limits-store';

afterEach(() => {
  __resetBackend();
});

describe('DataBackedTenantLimitsRepository (#313)', () => {
  it('未作成テナントは undefined（= 全項目既定値）', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    expect(await repo.get('tenant-none')).toBeUndefined();
  });

  it('put → get が round-trip する', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    await repo.put({
      id: 'tenant-a',
      receptionLogRetentionDays: 30,
      auditLogRetentionDays: 400,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(await repo.get('tenant-a')).toEqual({
      id: 'tenant-a',
      receptionLogRetentionDays: 30,
      auditLogRetentionDays: 400,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    // 別テナントは影響を受けない。
    expect(await repo.get('tenant-b')).toBeUndefined();
  });

  it('put は同一 id を置換する（テナント設定変更が以後の解決へ反映される, #313）', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    await repo.put({ id: 'tenant-a', auditLogRetentionDays: 400, updatedAt: '2026-07-01T00:00:00.000Z' });
    await repo.put({ id: 'tenant-a', auditLogRetentionDays: 500, updatedAt: '2026-07-02T00:00:00.000Z' });
    expect((await repo.get('tenant-a'))?.auditLogRetentionDays).toBe(500);
  });

  it('reset で初期状態へ戻る（テスト導線）', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    await repo.put({ id: 'tenant-a', updatedAt: '2026-07-01T00:00:00.000Z' });
    await repo.reset();
    expect(await repo.get('tenant-a')).toBeUndefined();
  });
});
