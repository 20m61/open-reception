import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import type { CreateReservationInput } from '@/domain/reservation/types';
import { MemoryReservationRepository } from './memory-repository';
import { ReservationService, type AppendAudit } from './service';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');

const developer: Actor = {
  status: 'active',
  assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
};
const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};

function makeService(): {
  svc: ReservationService;
  audits: Array<{ action: AuditAction; metadata?: Record<string, string> }>;
} {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _target, metadata) => {
    audits.push({ action, metadata });
  });
  const svc = new ReservationService({
    repo: new MemoryReservationRepository(),
    appendAudit,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
  });
  return { svc, audits };
}

function input(over: Partial<CreateReservationInput> = {}): CreateReservationInput {
  return {
    tenantId: T_A,
    siteId: S_1,
    visitorName: '山田太郎',
    companyName: 'ACME',
    visitAt: '2026-06-20T01:00:00.000Z',
    note: '機密の打合せ',
    targetType: 'staff',
    targetId: 'staff-1',
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    retentionDays: 30,
    ...over,
  };
}

describe('ReservationService.create (#97)', () => {
  it('予約を作成し token を発行、作成と token 発行を監査する', async () => {
    const { svc, audits } = makeService();
    const r = await svc.create(tenantAdminA, input());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('active');
      expect(r.value.token).toHaveLength(43);
    }
    expect(audits.map((a) => a.action)).toEqual(['reservation.created', 'reservation.token_issued']);
  });

  it('監査 metadata に PII（氏名/会社名/メモ）を残さない', async () => {
    const { svc, audits } = makeService();
    await svc.create(tenantAdminA, input());
    for (const a of audits) {
      const json = JSON.stringify(a.metadata ?? {});
      expect(json).not.toContain('山田太郎');
      expect(json).not.toContain('ACME');
      expect(json).not.toContain('機密');
    }
  });

  it('無効入力は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, input({ visitorName: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

describe('ReservationService 認可境界 (#80/#97)', () => {
  it('別テナントの actor は作成できない（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, input({ tenantId: T_B }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('viewer は書き込みできない（forbidden）が読み取りはできる', async () => {
    const { svc } = makeService();
    const created = await svc.create(developer, input());
    expect(created.ok).toBe(true);
    const write = await svc.create(viewerA, input());
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('forbidden');
    const read = await svc.list(viewerA, T_A, S_1);
    expect(read.ok).toBe(true);
  });

  it('別テナントの actor は一覧/取得で forbidden', async () => {
    const { svc } = makeService();
    const created = await svc.create(developer, input());
    const id = created.ok ? created.value.id : '';
    const list = await svc.list(tenantAdminA, T_B, S_1);
    expect(list.ok).toBe(false);
    const get = await svc.get(tenantAdminA, T_B, S_1, id as never);
    expect(get.ok).toBe(false);
  });
});

describe('ReservationService ライフサイクル (#97)', () => {
  it('cancel / revoke を監査付きで実行', async () => {
    const { svc, audits } = makeService();
    const created = await svc.create(developer, input());
    const id = created.ok ? created.value.id : (undefined as never);
    const cancelled = await svc.cancel(developer, T_A, S_1, id);
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    expect(audits.map((a) => a.action)).toContain('reservation.cancelled');
  });

  it('reissueToken: 新トークンを発行し旧トークンを無効化、再発行を監査', async () => {
    const { svc, audits } = makeService();
    const created = await svc.create(developer, input());
    const id = created.ok ? created.value.id : (undefined as never);
    const oldToken = created.ok ? created.value.token : '';
    const reissued = await svc.reissueToken(developer, T_A, S_1, id, '2026-07-01T00:00:00.000Z');
    expect(reissued.ok).toBe(true);
    if (reissued.ok) {
      expect(reissued.value.token).not.toBe(oldToken);
      expect(reissued.value.status).toBe('active');
    }
    expect(audits.map((a) => a.action)).toContain('reservation.token_reissued');
  });

  it('存在しない予約は not_found', async () => {
    const { svc } = makeService();
    const r = await svc.cancel(developer, T_A, S_1, 'rsv-missing' as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });

  it('期限切れ予約は参照時に expired へ反映され、編集は invalid_state', async () => {
    let clock = new Date('2026-06-20T00:00:00.000Z');
    const repo = new MemoryReservationRepository();
    const svc = new ReservationService({ repo, appendAudit: async () => {}, now: () => clock });
    const created = await svc.create(
      developer,
      input({ visitAt: '2026-06-20T00:10:00.000Z', expiresAt: '2026-06-20T00:30:00.000Z' }),
    );
    expect(created.ok).toBe(true);
    const id = created.ok ? created.value.id : (undefined as never);
    // 期限後へ進める。
    clock = new Date('2026-06-21T00:00:00.000Z');
    const edit = await svc.edit(developer, T_A, S_1, id, { visitorName: 'x' });
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error.code).toBe('invalid_state');
    // 参照時に expired が永続化されている。
    const got = await svc.get(developer, T_A, S_1, id);
    expect(got.ok && got.value.status).toBe('expired');
  });
});
