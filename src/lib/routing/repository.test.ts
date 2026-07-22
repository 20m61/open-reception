import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  MemoryContactEndpointRepository,
  MemoryRoutingPolicyRepository,
} from './repository';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

function endpoint(over: Partial<StoredContactEndpoint> & Pick<StoredContactEndpoint, 'id'>): StoredContactEndpoint {
  return {
    ownerType: 'staff',
    ownerId: 'staff-1',
    channel: 'pstn',
    e164: '+81300000000',
    providerKey: 'vonage',
    enabled: true,
    tenantId: String(T_A),
    siteId: String(S_A1),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredContactEndpoint;
}

function policy(over: Partial<StoredRoutingPolicy> & Pick<StoredRoutingPolicy, 'id'>): StoredRoutingPolicy {
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

describe('MemoryContactEndpointRepository (テナント/サイト境界)', () => {
  it('list は tenantId で絞り、他テナントを混ぜない', async () => {
    const repo = new MemoryContactEndpointRepository([
      endpoint({ id: 'ep-a' }),
      endpoint({ id: 'ep-b', tenantId: String(T_B) }),
    ]);
    const a = await repo.list(T_A);
    expect(a.map((e) => e.id)).toEqual(['ep-a']);
  });

  it('list は siteId 指定でそのサイトに絞る', async () => {
    const repo = new MemoryContactEndpointRepository([
      endpoint({ id: 'ep-a1', siteId: String(S_A1) }),
      endpoint({ id: 'ep-a2', siteId: String(S_A2) }),
    ]);
    const a1 = await repo.list(T_A, S_A1);
    expect(a1.map((e) => e.id)).toEqual(['ep-a1']);
  });

  it('get は他テナントの id を返さない', async () => {
    const repo = new MemoryContactEndpointRepository([endpoint({ id: 'ep-b', tenantId: String(T_B) })]);
    expect(await repo.get(T_A, 'ep-b')).toBeUndefined();
    expect(await repo.get(T_B, 'ep-b')).toBeDefined();
  });

  it('create は id 衝突で conflict', async () => {
    const repo = new MemoryContactEndpointRepository([endpoint({ id: 'ep-a' })]);
    const r = await repo.create(endpoint({ id: 'ep-a' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });

  it('delete は他テナント id を not_found にする（越境削除拒否）', async () => {
    const repo = new MemoryContactEndpointRepository([endpoint({ id: 'ep-b', tenantId: String(T_B) })]);
    const r = await repo.remove(T_A, 'ep-b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});

describe('MemoryRoutingPolicyRepository (テナント/サイト境界)', () => {
  it('list は tenantId で絞る', async () => {
    const repo = new MemoryRoutingPolicyRepository([
      policy({ id: 'p-a' }),
      policy({ id: 'p-b', tenantId: String(T_B) }),
    ]);
    const a = await repo.list(T_A);
    expect(a.map((p) => p.id)).toEqual(['p-a']);
  });

  it('get は他テナントの id を返さない', async () => {
    const repo = new MemoryRoutingPolicyRepository([policy({ id: 'p-b', tenantId: String(T_B) })]);
    expect(await repo.get(T_A, 'p-b')).toBeUndefined();
  });

  it('put で上書きできる', async () => {
    const repo = new MemoryRoutingPolicyRepository([policy({ id: 'p-a' })]);
    await repo.put(policy({ id: 'p-a', name: '改名' }));
    const got = await repo.get(T_A, 'p-a');
    expect(got?.name).toBe('改名');
  });
});
