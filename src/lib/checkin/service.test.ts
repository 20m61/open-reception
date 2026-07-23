import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationToken,
  type VisitReservation,
} from '@/domain/reservation/types';
import { buildReservationCheckinUrl, hashReservationToken } from '@/domain/reservation/token';
import { MemoryReservationRepository } from '@/lib/reservation/memory-repository';
import { CheckinService } from './service';

const TENANT = asTenantId('dev-tenant');
const SITE = asSiteId('dev-site');
const OTHER_SITE = asSiteId('other-site');
const TOKEN = asReservationToken('reservation-token-abc');
const TOKEN_HASH = hashReservationToken(TOKEN);
const NOW = new Date('2026-06-20T01:00:00.000Z');

function res(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: TENANT,
    siteId: SITE,
    visitorName: '山田太郎',
    companyName: '株式会社サンプル',
    note: '機密メモ',
    visitAt: '2026-06-20T00:30:00.000Z',
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

function makeService(seed: VisitReservation[]) {
  const repo = new MemoryReservationRepository(seed);
  return { repo, service: new CheckinService({ repo, now: () => NOW }) };
}

describe('CheckinService.resolve (issue #98)', () => {
  it('有効な token から最小限のサマリを返す（token / note / id を含めない）', async () => {
    const { service } = makeService([res()]);
    const r = await service.resolve(TENANT, SITE, TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary).toEqual({
        visitorName: '山田太郎',
        companyName: '株式会社サンプル',
        visitAt: '2026-06-20T00:30:00.000Z',
        targetType: 'staff',
        targetId: 'staff-1',
        usagePolicy: 'single_use',
      });
      // 余分な PII / 長期有効値を確認画面へ漏らさない。
      expect(r.summary as Record<string, unknown>).not.toHaveProperty('note');
      expect(r.summary as Record<string, unknown>).not.toHaveProperty('token');
      expect(r.summary as Record<string, unknown>).not.toHaveProperty('id');
    }
  });

  it('#97 の checkin URL（QR payload）でも解決できる', async () => {
    const { service } = makeService([res()]);
    const url = buildReservationCheckinUrl('https://kiosk.example.com', TOKEN);
    const r = await service.resolve(TENANT, SITE, url);
    expect(r.ok).toBe(true);
  });

  it('resolve は使用済み化しない（閲覧のみ）', async () => {
    const { repo, service } = makeService([res()]);
    await service.resolve(TENANT, SITE, TOKEN);
    const after = await repo.get(TENANT, SITE, asReservationId('rsv-1'));
    expect(after?.status).toBe('active');
    expect(after?.usedAt).toBeUndefined();
  });

  it('期限切れ / 使用済み / 失効 / 不正 / 該当なし を区別して返す', async () => {
    const expired = makeService([res({ expiresAt: '2026-06-19T00:00:00.000Z' })]);
    expect(await expired.service.resolve(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'expired' });

    const used = makeService([res({ status: 'used' })]);
    expect(await used.service.resolve(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'used' });

    const revoked = makeService([res({ status: 'revoked' })]);
    expect(await revoked.service.resolve(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'revoked' });

    const invalid = makeService([res()]);
    expect(await invalid.service.resolve(TENANT, SITE, 'bad token!')).toEqual({
      ok: false,
      reason: 'invalid',
    });

    const missing = makeService([res()]);
    expect(await missing.service.resolve(TENANT, SITE, asReservationToken('nope'))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('期限切れを参照時に状態へ永続反映する', async () => {
    const { repo, service } = makeService([res({ expiresAt: '2026-06-19T00:00:00.000Z' })]);
    await service.resolve(TENANT, SITE, TOKEN);
    const after = await repo.get(TENANT, SITE, asReservationId('rsv-1'));
    expect(after?.status).toBe('expired');
  });

  it('テナント/サイト越境では解決できない（二重防御）', async () => {
    const { service } = makeService([res()]);
    expect(await service.resolve(TENANT, OTHER_SITE, TOKEN)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('same_day は予定日当日外だと expired 扱い', async () => {
    const { service } = makeService([
      res({ usagePolicy: 'same_day', visitAt: '2026-06-19T00:30:00.000Z' }),
    ]);
    expect(await service.resolve(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('CheckinService.confirm (issue #98)', () => {
  it('確認後のみ使用済み化する（single_use → used）', async () => {
    const { repo, service } = makeService([res()]);
    const r = await service.confirm(TENANT, SITE, TOKEN);
    expect(r.ok).toBe(true);
    const after = await repo.get(TENANT, SITE, asReservationId('rsv-1'));
    expect(after?.status).toBe('used');
    expect(after?.usedAt).toBe(NOW.toISOString());
  });

  it('使用済みの予約を二度はチェックインできない', async () => {
    const { service } = makeService([res()]);
    expect((await service.confirm(TENANT, SITE, TOKEN)).ok).toBe(true);
    expect(await service.confirm(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'used' });
  });

  it('期限切れの予約は confirm できず理由を返す', async () => {
    const { service } = makeService([res({ expiresAt: '2026-06-19T00:00:00.000Z' })]);
    expect(await service.confirm(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'expired' });
  });

  it('失効済みの予約は confirm できない', async () => {
    const { service } = makeService([res({ status: 'revoked' })]);
    expect(await service.confirm(TENANT, SITE, TOKEN)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('不正 payload は invalid', async () => {
    const { service } = makeService([res()]);
    expect(await service.confirm(TENANT, SITE, 'bad!')).toEqual({ ok: false, reason: 'invalid' });
  });
});
