import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import type { Actor } from '@/domain/tenant/authorization';
import { asStayId, type VisitStay } from '@/domain/visit/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedStayRepository } from './repository';
import { StayService, durationBucket, type AppendAudit } from './service';

// #274 ①: memory repository は廃止。memory backend + seed で単一実装を直接検証する（§9.2）。
afterEach(() => {
  __resetBackend();
});

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');
const OTHER = asSiteId('site-2');
const NOW = new Date('2026-06-20T10:00:00.000Z');

const admin: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T, siteId: null, deviceId: null }],
};
const outsider: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: asTenantId('tenant-b'), siteId: null, deviceId: null }],
};

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
  __resetBackend();
  const repo = new DataBackedStayRepository(() => seed.map((s) => ({ ...s })));
  const appendAudit = vi.fn<AppendAudit>().mockResolvedValue(undefined);
  return { repo, appendAudit, service: new StayService({ repo, appendAudit, now: () => NOW }) };
}

describe('StayService.checkOut (issue #102)', () => {
  it('present を退館済みにし、滞在時間を確定する', async () => {
    const { service, repo } = makeService([stay()]);
    const r = await service.checkOut(admin, T, S, asStayId('stay-1'));
    expect(r.ok).toBe(true);
    const after = await repo.get(T, S, asStayId('stay-1'));
    expect(after?.status).toBe('checked_out');
    expect(after?.durationMs).toBe(60 * 60 * 1000);
  });

  it('二重退館を防ぐ（2 度目は invalid_state=409 相当）', async () => {
    const { service } = makeService([stay()]);
    expect((await service.checkOut(admin, T, S, asStayId('stay-1'))).ok).toBe(true);
    const second = await service.checkOut(admin, T, S, asStayId('stay-1'));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('invalid_state');
  });

  it('退館を監査に残すが PII は残さない（status / durationBucket のみ）', async () => {
    const { service, appendAudit } = makeService([stay()]);
    await service.checkOut(admin, T, S, asStayId('stay-1'));
    expect(appendAudit).toHaveBeenCalledWith(
      'visitor.checked_out',
      { type: 'stay', id: 'stay-1' },
      { status: 'checked_out', durationBucket: 'lt_4h' },
    );
    // metadata に氏名・会社名・生の滞在時間を含めない。
    const meta = appendAudit.mock.calls[0]?.[2] ?? {};
    expect(Object.keys(meta)).toEqual(['status', 'durationBucket']);
    expect(JSON.stringify(meta)).not.toContain('durationMs');
  });

  it('他テナントの actor は forbidden（API 側で 403）', async () => {
    const { service } = makeService([stay()]);
    const r = await service.checkOut(outsider, T, S, asStayId('stay-1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('別サイトのスコープでは滞在を越境取得できず not_found（テナント全体権限でも site で分離）', async () => {
    const { service } = makeService([stay()]);
    const r = await service.checkOut(admin, T, OTHER, asStayId('stay-1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});

describe('StayService.createPresent / list (issue #102)', () => {
  it('PII を持たない present レコードを起票し、起票を監査する', async () => {
    const { service, appendAudit } = makeService();
    const r = await service.createPresent(admin, { tenantId: T, siteId: S, receptionId: 'rcp-1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('present');
      expect(r.value.receptionId).toBe('rcp-1');
      expect(r.value as Record<string, unknown>).not.toHaveProperty('visitorName');
    }
    expect(appendAudit).toHaveBeenCalledWith('stay.updated', expect.anything(), expect.anything());
  });

  it('list はサイト境界でフィルタする', async () => {
    const { service } = makeService([stay(), stay({ id: asStayId('stay-2'), siteId: OTHER })]);
    const r = await service.list(admin, T, S);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((s) => s.id)).toEqual(['stay-1']);
  });
});

describe('durationBucket (issue #102)', () => {
  it('滞在時間を PII にならない粒度へ丸める', () => {
    expect(durationBucket(undefined)).toBe('unknown');
    expect(durationBucket(5 * 60000)).toBe('lt_15m');
    expect(durationBucket(30 * 60000)).toBe('lt_1h');
    expect(durationBucket(2 * 60 * 60000)).toBe('lt_4h');
    expect(durationBucket(6 * 60 * 60000)).toBe('lt_8h');
    expect(durationBucket(10 * 60 * 60000)).toBe('gte_8h');
  });
});
