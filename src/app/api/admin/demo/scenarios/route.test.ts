/**
 * /api/admin/demo/scenarios — カスタムデモシナリオの一覧・作成 (issue #363 Inc2)。
 * 認可（#91）: requireActor + assertCanRead/assertCanWrite（viewer 書込不可・越境拒否）。
 * 保存は validateDemoScenario で強制し、監査 reception.demo_scenario_saved を PII なしで残す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import type { DemoScenario } from '@/domain/demo-studio/scenario';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();
const listSavedDemoScenarios = vi.fn<() => Promise<DemoScenario[]>>();
const saveDemoScenario = vi.fn<(s: DemoScenario) => Promise<void>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({ defaultTenantId: 'tenant-demo' }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...args: unknown[]) => appendAdminAudit(...args),
}));
vi.mock('@/domain/demo-studio/store', () => ({
  listSavedDemoScenarios: () => listSavedDemoScenarios(),
  saveDemoScenario: (s: DemoScenario) => saveDemoScenario(s),
}));

import { GET, POST } from './route';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
function post(body: unknown): Promise<Response> {
  return POST(new Request('http://x/api/admin/demo/scenarios', { method: 'POST', body: JSON.stringify(body) }));
}
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'マイシナリオ',
    initialMode: 'reception',
    visitorInputs: [{ mode: 'touch', value: 'meeting' }],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  saveDemoScenario.mockResolvedValue();
  listSavedDemoScenarios.mockResolvedValue([]);
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
});

describe('GET /api/admin/demo/scenarios', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('viewer は読み取り可（200・一覧を返す）', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    listSavedDemoScenarios.mockResolvedValue([
      { id: 'custom-a', name: 'A', initialMode: 'reception', visitorInputs: [], simulatedResults: {} },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});

describe('POST /api/admin/demo/scenarios', () => {
  it('未認証は 401・保存も監査もしない', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await post(draft())).status).toBe(401);
    expect(saveDemoScenario).not.toHaveBeenCalled();
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('viewer は 403・保存しない', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await post(draft())).status).toBe(403);
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('不正なシナリオは 400・フィールド別エラー・保存しない', async () => {
    const res = await post(draft({ initialMode: 'lobby', name: '' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.initialMode).toBeDefined();
    expect(body.errors.name).toBeDefined();
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('URL 混入のシナリオは 400（sandbox 内容境界）', async () => {
    const res = await post(draft({ name: 'https://evil.example' }));
    expect(res.status).toBe(400);
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('admin は 201・合成 id を採番・監査 reception.demo_scenario_saved（PII なし）', async () => {
    const res = await post(draft());
    expect(res.status).toBe(201);
    const saved = (await res.json()) as DemoScenario;
    expect(saved.id).toMatch(/^custom-/);
    expect(saveDemoScenario).toHaveBeenCalledTimes(1);
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_scenario_saved');
    expect(target).toMatchObject({ type: 'demo_scenario', id: saved.id });
    expect(metadata).toEqual({ scenarioId: saved.id, initialMode: 'reception' });
    // 監査に文言（name）を残さない。
    expect(JSON.stringify(metadata)).not.toContain('マイシナリオ');
  });
});
