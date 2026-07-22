/**
 * /api/admin/demo/publications — 公開単位の一覧/作成 (issue #363 Inc3)。
 * 認可（#91）: requireActor + assertCanRead/assertCanWrite（viewer 書込不可）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import type { DemoScenario } from '@/domain/demo-studio/scenario';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();
const getSavedDemoScenario = vi.fn<(id: string) => Promise<DemoScenario | undefined>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({ defaultTenantId: 'tenant-demo' }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...args: unknown[]) => appendAdminAudit(...args),
}));
vi.mock('@/domain/demo-studio/store', () => ({
  getSavedDemoScenario: (id: string) => getSavedDemoScenario(id),
}));

import { GET, POST } from './route';
import { __resetDemoPublications, listDemoPublications } from '@/domain/demo-studio/publication-store';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
function post(body: unknown): Promise<Response> {
  return POST(new Request('http://x/api/admin/demo/publications', { method: 'POST', body: JSON.stringify(body) }));
}
function scenario(id: string): DemoScenario {
  return { id, name: 'デモ', initialMode: 'reception', visitorInputs: [], simulatedResults: {} };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetDemoPublications();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
  getSavedDemoScenario.mockImplementation(async (id) => (id === 'custom-x' ? scenario('custom-x') : undefined));
});

describe('POST /api/admin/demo/publications', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await post({ scenarioId: 'custom-x' })).status).toBe(401);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });
  it('viewer は 403', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await post({ scenarioId: 'custom-x' })).status).toBe(403);
  });
  it('未知シナリオは 400', async () => {
    expect((await post({ scenarioId: 'ghost' })).status).toBe(400);
  });
  it('scenarioId 欠落は 400', async () => {
    expect((await post({})).status).toBe(400);
  });
  it('admin は draft を作成し監査する', async () => {
    const res = await post({ scenarioId: 'custom-x' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('draft');
    expect(body.scenarioId).toBe('custom-x');
    expect(body.id).toMatch(/^pub-/);
    const saved = await listDemoPublications();
    expect(saved).toHaveLength(1);
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_publication_created');
    expect(target).toMatchObject({ type: 'demo_publication' });
    expect(metadata).toMatchObject({ event: 'publication_created', scenarioId: 'custom-x' });
  });
});

describe('GET /api/admin/demo/publications', () => {
  it('viewer でも read は許可（一覧取得）', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
