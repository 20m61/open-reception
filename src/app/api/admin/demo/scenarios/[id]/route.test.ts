/**
 * /api/admin/demo/scenarios/[id] — カスタムデモシナリオの解決・更新・削除 (issue #363 Inc2)。
 * GET は 保存済み→組込 の解決点（プレビュー iframe が id で解決する）。
 * PUT/DELETE は書込権を要求し、監査 reception.demo_scenario_saved / _deleted を PII なしで残す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import type { DemoScenario } from '@/domain/demo-studio/scenario';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();
const resolveDemoScenario = vi.fn<(id: string) => Promise<DemoScenario | undefined>>();
const getSavedDemoScenario = vi.fn<(id: string) => Promise<DemoScenario | undefined>>();
const saveDemoScenario = vi.fn<(s: DemoScenario) => Promise<void>>();
const deleteSavedDemoScenario = vi.fn<(id: string) => Promise<void>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({ defaultTenantId: 'tenant-demo' }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...args: unknown[]) => appendAdminAudit(...args),
}));
vi.mock('@/domain/demo-studio/store', () => ({
  resolveDemoScenario: (id: string) => resolveDemoScenario(id),
  getSavedDemoScenario: (id: string) => getSavedDemoScenario(id),
  saveDemoScenario: (s: DemoScenario) => saveDemoScenario(s),
  deleteSavedDemoScenario: (id: string) => deleteSavedDemoScenario(id),
}));

import { DELETE, GET, PUT } from './route';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function scenario(id: string): DemoScenario {
  return {
    id,
    name: 'マイシナリオ',
    initialMode: 'reception',
    visitorInputs: [{ mode: 'touch', value: 'meeting' }],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  };
}
function put(id: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://x/api/admin/demo/scenarios/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    ctx(id),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  saveDemoScenario.mockResolvedValue();
  deleteSavedDemoScenario.mockResolvedValue();
  getSavedDemoScenario.mockResolvedValue(scenario('custom-1'));
  resolveDemoScenario.mockResolvedValue(scenario('custom-1'));
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
});

describe('GET /api/admin/demo/scenarios/[id]', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET(new Request('http://x'), ctx('custom-1'))).status).toBe(401);
  });

  it('解決順（保存済み→組込）で解決し 200 を返す', async () => {
    const res = await GET(new Request('http://x'), ctx('normal-visit'));
    expect(res.status).toBe(200);
    expect(resolveDemoScenario).toHaveBeenCalledWith('normal-visit');
  });

  it('未知 id は 404', async () => {
    resolveDemoScenario.mockResolvedValue(undefined);
    expect((await GET(new Request('http://x'), ctx('ghost'))).status).toBe(404);
  });
});

describe('PUT /api/admin/demo/scenarios/[id]', () => {
  it('viewer は 403・保存しない', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await put('custom-1', scenario('custom-1'))).status).toBe(403);
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('既存が無ければ 404', async () => {
    getSavedDemoScenario.mockResolvedValue(undefined);
    expect((await put('custom-1', scenario('custom-1'))).status).toBe(404);
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('不正内容は 400・フィールド別エラー', async () => {
    const res = await put('custom-1', { ...scenario('custom-1'), initialMode: 'lobby' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.initialMode).toBeDefined();
    expect(saveDemoScenario).not.toHaveBeenCalled();
  });

  it('admin は 200・パス id で保存・監査 saved（PII なし）', async () => {
    // body の id は無視し、パスの id で保存する。
    const res = await put('custom-1', { ...scenario('other-id') });
    expect(res.status).toBe(200);
    const [saved] = saveDemoScenario.mock.calls[0]!;
    expect((saved as DemoScenario).id).toBe('custom-1');
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_scenario_saved');
    expect(target).toMatchObject({ type: 'demo_scenario', id: 'custom-1' });
    expect(metadata).toEqual({ scenarioId: 'custom-1', initialMode: 'reception' });
  });
});

describe('DELETE /api/admin/demo/scenarios/[id]', () => {
  it('viewer は 403・削除しない', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('custom-1'))).status).toBe(403);
    expect(deleteSavedDemoScenario).not.toHaveBeenCalled();
  });

  it('組込テンプレート id は削除不可 400', async () => {
    getSavedDemoScenario.mockResolvedValue(undefined);
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('normal-visit'));
    expect(res.status).toBe(404);
    expect(deleteSavedDemoScenario).not.toHaveBeenCalled();
  });

  it('admin は 200・削除・監査 deleted', async () => {
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('custom-1'));
    expect(res.status).toBe(200);
    expect(deleteSavedDemoScenario).toHaveBeenCalledWith('custom-1');
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_scenario_deleted');
    expect(target).toMatchObject({ type: 'demo_scenario', id: 'custom-1' });
    expect(metadata).toEqual({ scenarioId: 'custom-1', initialMode: 'reception' });
  });
});
