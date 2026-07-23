import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationToken,
  type LegacyVisitReservation,
  type VisitReservation,
} from '@/domain/reservation/types';
import { hashReservationToken } from '@/domain/reservation/token';
import { migrateReservationToHashed } from '@/domain/reservation/migration';
import { MemoryReservationRepository } from './memory-repository';

const TOKEN = asReservationToken('reservation-plain-token');
const TOKEN_HASH = hashReservationToken(TOKEN);

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
    tokenHash: TOKEN_HASH,
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

  it('findByTokenHash: 入力 token の hash で引け、境界一致のみ返す（#375）', async () => {
    const repo = new MemoryReservationRepository([res()]);
    // 保存は hash のみ。照合は生 token を hash して突き合わせる。
    expect(await repo.findByTokenHash(T_A, S_1, hashReservationToken(TOKEN))).toMatchObject({
      id: 'rsv-1',
    });
    expect(await repo.findByTokenHash(T_B, S_1, hashReservationToken(TOKEN))).toBeUndefined();
  });

  it('findByTokenHash: 改竄 token（別 hash）は一致しない（#375）', async () => {
    const repo = new MemoryReservationRepository([res()]);
    const tampered = hashReservationToken(asReservationToken('reservation-plain-token-TAMPERED'));
    expect(await repo.findByTokenHash(T_A, S_1, tampered)).toBeUndefined();
  });

  it('保存レコードに生 token を持たない（hash のみ・#375）', async () => {
    const repo = new MemoryReservationRepository([res()]);
    const got = await repo.get(T_A, S_1, asReservationId('rsv-1'));
    expect((got as Record<string, unknown>).token).toBeUndefined();
    expect(got?.tokenHash).toBe(TOKEN_HASH);
  });

  it('現行QRデータ移行: 平文 token の旧レコードを移行後も hash で引ける（#375）', async () => {
    const legacy: LegacyVisitReservation = {
      ...res(),
      token: asReservationToken('legacy-plain'),
    } as unknown as LegacyVisitReservation;
    // 旧レコードには本来 tokenHash が無い。移行前提の形にする。
    delete (legacy as Record<string, unknown>).tokenHash;
    const migrated = migrateReservationToHashed(legacy);
    const repo = new MemoryReservationRepository([migrated]);
    expect(
      await repo.findByTokenHash(T_A, S_1, hashReservationToken(asReservationToken('legacy-plain'))),
    ).toMatchObject({ id: 'rsv-1' });
    // 移行後レコードに平文は残らない。
    expect((migrated as Record<string, unknown>).token).toBeUndefined();
  });

  it('返り値は防御的コピー（外部変更が内部へ波及しない）', async () => {
    const repo = new MemoryReservationRepository([res()]);
    const got = await repo.get(T_A, S_1, asReservationId('rsv-1'));
    got!.visitorName = 'tampered';
    const again = await repo.get(T_A, S_1, asReservationId('rsv-1'));
    expect(again!.visitorName).toBe('山田太郎');
  });
});
