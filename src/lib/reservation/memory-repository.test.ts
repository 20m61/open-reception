import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationToken,
  type VisitReservation,
} from '@/domain/reservation/types';
import { MemoryReservationRepository } from './memory-repository';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');

function res(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: T_A,
    siteId: S_1,
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    token: asReservationToken('tok-1'),
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

describe('MemoryReservationRepository (#97)', () => {
  it('create / get / list', async () => {
    const repo = new MemoryReservationRepository();
    const created = await repo.create(res());
    expect(created.ok).toBe(true);
    expect(await repo.get(T_A, S_1, asReservationId('rsv-1'))).toMatchObject({ id: 'rsv-1' });
    expect(await repo.list(T_A, S_1)).toHaveLength(1);
  });

  it('id 重複は conflict', async () => {
    const repo = new MemoryReservationRepository([res()]);
    const r = await repo.create(res());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });

  it('テナント越境: 別テナントからは get/list で見えない', async () => {
    const repo = new MemoryReservationRepository([res()]);
    expect(await repo.get(T_B, S_1, asReservationId('rsv-1'))).toBeUndefined();
    expect(await repo.list(T_B, S_1)).toHaveLength(0);
  });

  it('サイト越境: 別サイトからは見えない', async () => {
    const repo = new MemoryReservationRepository([res()]);
    expect(await repo.get(T_A, S_2, asReservationId('rsv-1'))).toBeUndefined();
    expect(await repo.list(T_A, S_2)).toHaveLength(0);
  });

  it('findByToken: 境界一致のみ返す', async () => {
    const repo = new MemoryReservationRepository([res()]);
    expect(await repo.findByToken(T_A, S_1, asReservationToken('tok-1'))).toMatchObject({ id: 'rsv-1' });
    expect(await repo.findByToken(T_B, S_1, asReservationToken('tok-1'))).toBeUndefined();
  });

  it('返り値は防御的コピー（外部変更が内部へ波及しない）', async () => {
    const repo = new MemoryReservationRepository([res()]);
    const got = await repo.get(T_A, S_1, asReservationId('rsv-1'));
    got!.visitorName = 'tampered';
    const again = await repo.get(T_A, S_1, asReservationId('rsv-1'));
    expect(again!.visitorName).toBe('山田太郎');
  });
});
