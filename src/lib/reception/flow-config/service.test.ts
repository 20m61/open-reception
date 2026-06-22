import { describe, expect, it, vi } from 'vitest';
import { asReceptionFlowId } from '@/domain/reception/custom-flow';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryReceptionFlowRepository } from './repository';
import { ReceptionFlowService, type AppendAudit } from './service';
import type { StoredReceptionFlow } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

const developer: Actor = {
  status: 'active',
  assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
};
const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const siteManagerA1: Actor = {
  status: 'active',
  assignments: [{ role: 'site_manager', tenantId: T_A, siteId: S_A1, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};

function flow(over: Partial<StoredReceptionFlow> & Pick<StoredReceptionFlow, 'id'>): StoredReceptionFlow {
  return {
    tenantId: T_A,
    siteId: S_A1,
    purposeKey: 'general',
    displayName: '通常',
    order: 0,
    enabled: true,
    steps: ['purpose', 'confirm', 'call'],
    fields: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
    id: over.id,
  } as StoredReceptionFlow;
}

function makeService(seed: StoredReceptionFlow[] = []) {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _t, metadata) => {
    audits.push({ action, metadata });
  });
  const repo = new MemoryReceptionFlowRepository(seed);
  const svc = new ReceptionFlowService({
    flows: repo,
    appendAudit,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
  });
  return { svc, audits, repo };
}

const SEED = [
  flow({ id: asReceptionFlowId('f-a1'), tenantId: T_A, siteId: S_A1, purposeKey: 'general' }),
  flow({ id: asReceptionFlowId('f-a2'), tenantId: T_A, siteId: S_A2, purposeKey: 'general' }),
  flow({ id: asReceptionFlowId('f-b1'), tenantId: T_B, siteId: asSiteId('site-b1'), purposeKey: 'general' }),
];

describe('ReceptionFlowService.list (#100)', () => {
  it('テナント配下のフローを返す', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((x) => x.id).sort()).toEqual(['f-a1', 'f-a2']);
  });

  it('site_manager は担当サイトのみ見える', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(siteManagerA1, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((x) => x.id)).toEqual(['f-a1']);
  });
});

describe('ReceptionFlowService.create (#100)', () => {
  it('tenant_admin は作成でき監査が残る（PII なし）', async () => {
    const { svc, audits, repo } = makeService();
    const r = await svc.create(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      purposeKey: 'interview',
      displayName: '面接',
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    });
    expect(r.ok).toBe(true);
    expect(audits[0]?.action).toBe('reception_flow.created');
    expect(audits[0]?.metadata?.purposeKey).toBe('interview');
    expect(audits[0]?.metadata?.fieldCount).toBe('1');
    expect((await repo.listFlows(T_A, S_A1)).length).toBe(1);
  });

  it('viewer は作成不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.create(viewerA, {
      tenantId: T_A,
      siteId: S_A1,
      purposeKey: 'interview',
      displayName: '面接',
      steps: ['purpose', 'confirm', 'call'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントへの作成は forbidden（越境拒否）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, {
      tenantId: T_B,
      siteId: asSiteId('site-b1'),
      purposeKey: 'interview',
      displayName: '面接',
      steps: ['purpose', 'confirm', 'call'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('不正な入力は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(developer, {
      tenantId: T_A,
      siteId: S_A1,
      purposeKey: 'BAD KEY',
      displayName: '面接',
      steps: ['purpose', 'confirm', 'call'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('purposeKey 重複は conflict', async () => {
    const { svc } = makeService([flow({ id: asReceptionFlowId('f1'), purposeKey: 'interview' })]);
    const r = await svc.create(developer, {
      tenantId: T_A,
      siteId: S_A1,
      purposeKey: 'interview',
      displayName: '面接2',
      steps: ['purpose', 'confirm', 'call'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });
});

describe('ReceptionFlowService.update/remove (#100)', () => {
  it('有効無効トグルと監査', async () => {
    const { svc, audits } = makeService([flow({ id: asReceptionFlowId('f1') })]);
    const r = await svc.update(tenantAdminA, T_A, asReceptionFlowId('f1'), { enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.enabled).toBe(false);
    expect(audits.at(-1)?.action).toBe('reception_flow.updated');
  });

  it('通知ルート(callRouteId)を割り当て・解除できる', async () => {
    const { svc } = makeService([flow({ id: asReceptionFlowId('f1') })]);
    const assigned = await svc.update(tenantAdminA, T_A, asReceptionFlowId('f1'), {
      callRouteId: 'route-xyz',
    });
    expect(assigned.ok).toBe(true);
    if (assigned.ok) expect(assigned.value.callRouteId).toBe('route-xyz');

    const cleared = await svc.update(tenantAdminA, T_A, asReceptionFlowId('f1'), {
      callRouteId: '',
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.callRouteId).toBeUndefined();
  });

  it('viewer は更新不可', async () => {
    const { svc } = makeService([flow({ id: asReceptionFlowId('f1') })]);
    const r = await svc.update(viewerA, T_A, asReceptionFlowId('f1'), { displayName: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('存在しないフローの更新は not_found', async () => {
    const { svc } = makeService();
    const r = await svc.update(developer, T_A, asReceptionFlowId('nope'), { enabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });

  it('削除でき監査が残る', async () => {
    const { svc, audits, repo } = makeService([flow({ id: asReceptionFlowId('f1') })]);
    const r = await svc.remove(tenantAdminA, T_A, asReceptionFlowId('f1'));
    expect(r.ok).toBe(true);
    expect(audits.at(-1)?.action).toBe('reception_flow.deleted');
    expect(await repo.getFlow(T_A, asReceptionFlowId('f1'))).toBeUndefined();
  });

  it('越境削除は forbidden（他テナント actor）', async () => {
    const { svc } = makeService([flow({ id: asReceptionFlowId('f1'), tenantId: T_A })]);
    const tenantAdminB: Actor = {
      status: 'active',
      assignments: [{ role: 'tenant_admin', tenantId: T_B, siteId: null, deviceId: null }],
    };
    const r = await svc.remove(tenantAdminB, T_A, asReceptionFlowId('f1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});

describe('ReceptionFlowService.listEnabledForKiosk (#100)', () => {
  it('有効フローのみ表示順で返す（actor 不要）', async () => {
    const { svc } = makeService([
      flow({ id: asReceptionFlowId('f1'), purposeKey: 'a', order: 2, enabled: true }),
      flow({ id: asReceptionFlowId('f2'), purposeKey: 'b', order: 0, enabled: false }),
      flow({ id: asReceptionFlowId('f3'), purposeKey: 'c', order: 1, enabled: true }),
    ]);
    const flows = await svc.listEnabledForKiosk(T_A, S_A1);
    expect(flows.map((f) => f.id)).toEqual(['f3', 'f1']);
  });
});
