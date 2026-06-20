import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId, type VisitStay } from '@/domain/visit/types';
import { MemoryStayRepository } from './memory-repository';
import { KioskStayService, parseStayId } from './kiosk-service';

const T = asTenantId('dev-tenant');
const S = asSiteId('dev-site');
const OTHER = asSiteId('other-site');
const NOW = new Date('2026-06-20T10:00:00.000Z');

function stay(over: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: T,
    siteId: S,
    status: 'present',
    checkedInAt: '2026-06-20T09:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: '2026-06-20T09:00:00.000Z',
    ...over,
  };
}

function makeService(seed: VisitStay[] = []) {
  const repo = new MemoryStayRepository(seed);
  return { repo, service: new KioskStayService({ repo, now: () => NOW }) };
}

describe('KioskStayService.checkOutById (issue #102)', () => {
  it('受付番号で退館を確定し、PII を含まないレシートを返す', async () => {
    const { service, repo } = makeService([stay()]);
    const r = await service.checkOutById(T, S, 'stay-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.receipt).toEqual({ stayId: 'stay-1', checkedOutAt: NOW.toISOString() });
      const keys = Object.keys(r.receipt);
      expect(keys).not.toContain('visitorName');
      expect(keys).not.toContain('reservationId');
    }
    expect((await repo.get(T, S, asStayId('stay-1')))?.status).toBe('checked_out');
  });

  it('二重退館を防ぐ（2 度目は already_checked_out）', async () => {
    const { service } = makeService([stay()]);
    expect((await service.checkOutById(T, S, 'stay-1')).ok).toBe(true);
    expect(await service.checkOutById(T, S, 'stay-1')).toEqual({
      ok: false,
      reason: 'already_checked_out',
    });
  });

  it('該当なしは not_found', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, S, 'nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('空入力は invalid', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, S, '   ')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('越境スコープでは退館できない（二重防御・not_found）', async () => {
    const { service } = makeService([stay()]);
    expect(await service.checkOutById(T, OTHER, 'stay-1')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('parseStayId (issue #102)', () => {
  it('空白を除去し、空・非文字列は null', () => {
    expect(parseStayId(' stay-1 ')).toBe('stay-1');
    expect(parseStayId('')).toBeNull();
    expect(parseStayId(undefined)).toBeNull();
    expect(parseStayId(42)).toBeNull();
  });
});
