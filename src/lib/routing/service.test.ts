import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryContactEndpointRepository, MemoryRoutingPolicyRepository } from './repository';
import { RoutingService } from './service';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');

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
const tenantAdminB: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_B, siteId: null, deviceId: null }],
};

function storedEndpoint(
  over: Partial<StoredContactEndpoint> & Pick<StoredContactEndpoint, 'id'>,
): StoredContactEndpoint {
  return {
    ownerType: 'staff',
    ownerId: 'staff-1',
    channel: 'pstn',
    e164: '+81312345678',
    providerKey: 'vonage',
    enabled: true,
    label: '担当者A',
    tenantId: String(T_A),
    siteId: String(S_A1),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredContactEndpoint;
}

function storedPolicy(over: Partial<StoredRoutingPolicy> & Pick<StoredRoutingPolicy, 'id'>): StoredRoutingPolicy {
  return {
    tenantId: String(T_A),
    siteId: String(S_A1),
    name: '標準ルート',
    enabled: true,
    steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredRoutingPolicy;
}

function makeService(opts: { endpoints?: StoredContactEndpoint[]; policies?: StoredRoutingPolicy[] } = {}) {
  const audits: Array<{ action: AuditAction; target: { type: string; id?: string }; metadata?: Record<string, string> }> = [];
  const appendAudit = async (
    action: AuditAction,
    target: { type: string; id?: string },
    metadata?: Record<string, string>,
  ) => {
    audits.push({ action, target, metadata });
    return undefined;
  };
  let counter = 0;
  const service = new RoutingService({
    endpoints: new MemoryContactEndpointRepository(opts.endpoints ?? []),
    policies: new MemoryRoutingPolicyRepository(opts.policies ?? []),
    appendAudit,
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    newId: () => `gen-${++counter}`,
  });
  return { service, audits };
}

describe('RoutingService endpoints', () => {
  it('作成: EndpointView を返し、アドレス（e164）を構造的に含めない', async () => {
    const { service, audits } = makeService();
    const r = await service.createEndpoint(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true, label: '総務代表' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toHaveProperty('e164');
    expect(r.value).not.toHaveProperty('uri');
    expect(r.value.maskedAddress).toBe('****9999');
    expect(r.value.label).toBe('総務代表');
    // 監査にアドレスが載らない。
    const created = audits.find((a) => a.action === 'contact_endpoint.created');
    expect(created).toBeDefined();
    expect(JSON.stringify(created?.metadata ?? {})).not.toContain('9999');
    expect(JSON.stringify(created?.metadata ?? {})).not.toContain('81312349999');
  });

  it('作成: 不正な e164 は invalid_input', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '0312345678', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('作成: viewer は forbidden', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(viewerA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('作成: 他テナント actor は forbidden（越境拒否）', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(tenantAdminB, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('一覧: 他テナントの接続先は含めない、maskedAddress のみ露出', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1' }), storedEndpoint({ id: 'ep-b', tenantId: String(T_B) })],
    });
    const r = await service.listEndpoints(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((e) => e.id)).toEqual(['ep-1']);
    expect(r.value[0]).not.toHaveProperty('e164');
    expect(r.value[0]?.maskedAddress).toBe('****5678');
  });

  it('更新: アドレス未指定なら既存を保持、label/enabled のみ変更', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.updateEndpoint(tenantAdminA, T_A, 'ep-1', { label: '新ラベル', enabled: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.label).toBe('新ラベル');
    expect(r.value.enabled).toBe(false);
    expect(r.value.maskedAddress).toBe('****5678');
  });

  it('更新: 他テナント actor は forbidden', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.updateEndpoint(tenantAdminB, T_A, 'ep-1', { label: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('削除: 監査に残し、越境削除は not_found', async () => {
    const { service, audits } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const cross = await service.removeEndpoint(tenantAdminB, T_A, 'ep-1');
    expect(cross.ok).toBe(false);
    const ok = await service.removeEndpoint(tenantAdminA, T_A, 'ep-1');
    expect(ok.ok).toBe(true);
    expect(audits.some((a) => a.action === 'contact_endpoint.deleted')).toBe(true);
  });
});

describe('RoutingService policies', () => {
  it('作成: 有効なポリシーは PolicyView（description つき）を返し監査に残る', async () => {
    const { service, audits } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1', label: '担当者A' })] });
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'テストルート', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('gen-1');
    expect(r.value.description[0]).toContain('テストルート');
    expect(r.value.description.some((l) => l.includes('担当者A'))).toBe(true);
    expect(audits.some((a) => a.action === 'routing_policy.created')).toBe(true);
  });

  it('作成: 未登録 endpoint を参照すると invalid_input（unknown_endpoint）', async () => {
    const { service } = makeService();
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'missing', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.issues?.some((i) => i.kind === 'unknown_endpoint')).toBe(true);
    }
  });

  it('作成: 空 step のポリシーは invalid_input（empty_policy）', async () => {
    const { service } = makeService();
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues?.some((i) => i.kind === 'empty_policy')).toBe(true);
  });

  it('更新: 相互 fallback で循環を作ると invalid_input（fallback_cycle）で保存拒否', async () => {
    const p1 = storedPolicy({ id: 'p1', fallbackPolicyId: 'p2' });
    const p2 = storedPolicy({ id: 'p2' });
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })], policies: [p1, p2] });
    // p2 の fallback を p1 にすると p1<->p2 で循環。
    const r = await service.updatePolicy(tenantAdminA, T_A, 'p2', { fallbackPolicyId: 'p1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.issues?.some((i) => i.kind === 'fallback_cycle')).toBe(true);
    }
    // 保存されていない（p2 の fallback は元のまま）。
    const got = await service.getPolicy(tenantAdminA, T_A, 'p2');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.fallbackPolicyId).toBeUndefined();
  });

  it('作成: viewer は forbidden、他テナントは forbidden', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const asViewer = await service.createPolicy(viewerA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(asViewer.ok).toBe(false);
    if (!asViewer.ok) expect(asViewer.error.code).toBe('forbidden');

    const asOther = await service.createPolicy(tenantAdminB, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(asOther.ok).toBe(false);
    if (!asOther.ok) expect(asOther.error.code).toBe('forbidden');
  });

  it('一覧: 他テナントのポリシーを含めない', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1' })],
      policies: [storedPolicy({ id: 'p-a' }), storedPolicy({ id: 'p-b', tenantId: String(T_B) })],
    });
    const r = await service.listPolicies(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((p) => p.id)).toEqual(['p-a']);
  });

  it('developer は横断で読める', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1', tenantId: String(T_B) })],
      policies: [storedPolicy({ id: 'p-b', tenantId: String(T_B) })],
    });
    const r = await service.listPolicies(developer, T_B);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((p) => p.id)).toEqual(['p-b']);
  });
});
