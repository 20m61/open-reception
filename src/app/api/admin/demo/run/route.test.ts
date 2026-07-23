/**
 * POST /api/admin/demo/run — 受付体験スタジオのデモ実行を監査記録する (issue #363 Inc1)。
 * 認可（#91）: requireActor + assertCanWrite（viewer 書込不可）。監査は appendAdminAudit。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import type { DemoScenario } from '@/domain/demo-studio/scenario';
import { asTenantId } from '@/domain/tenant/types';
import { getDemoScenario } from '@/domain/demo-studio/scenarios';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();
const resolveDemoScenario = vi.fn<(id: string) => Promise<DemoScenario | undefined>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({ defaultTenantId: 'tenant-demo' }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...args: unknown[]) => appendAdminAudit(...args),
}));
vi.mock('@/domain/demo-studio/store', () => ({
  resolveDemoScenario: (id: string) => resolveDemoScenario(id),
}));

import { POST } from './route';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  // developer は横断（tenantId null）、それ以外は既定テナントに割り当てる。
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://x/api/admin/demo/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
  // 既定は 保存済み→組込 と同じく組込を返す（Inc1 非退行）。
  resolveDemoScenario.mockImplementation(async (id) => getDemoScenario(id));
});

describe('POST /api/admin/demo/run', () => {
  it('未認証は 401・監査しない', async () => {
    resolveAdminActor.mockResolvedValue(null);
    const res = await post({ scenarioId: 'normal-visit' });
    expect(res.status).toBe(401);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('viewer は書込不可 403・監査しない', async () => {
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    const res = await post({ scenarioId: 'normal-visit' });
    expect(res.status).toBe(403);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('未知の scenarioId は 400・監査しない', async () => {
    const res = await post({ scenarioId: 'no-such' });
    expect(res.status).toBe(400);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('scenarioId 欠落は 400', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('admin は 200・reception.demo_executed を scenarioId/initialMode 付きで監査（PII なし）', async () => {
    const res = await post({ scenarioId: 'qr-checkin-valid' });
    expect(res.status).toBe(200);
    expect(appendAdminAudit).toHaveBeenCalledTimes(1);
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_executed');
    expect(target).toMatchObject({ type: 'demo', id: 'qr-checkin-valid' });
    expect(metadata).toEqual({ scenarioId: 'qr-checkin-valid', initialMode: 'qr' });
  });

  it('カスタムシナリオ（保存済み→組込 解決）のデモ実行も記録する (Inc2)', async () => {
    resolveDemoScenario.mockResolvedValue({
      id: 'custom-xyz',
      name: 'マイシナリオ',
      initialMode: 'reception',
      visitorInputs: [],
      simulatedResults: {},
    });
    const res = await post({ scenarioId: 'custom-xyz' });
    expect(res.status).toBe(200);
    const [action, target, metadata] = appendAdminAudit.mock.calls[0]!;
    expect(action).toBe('reception.demo_executed');
    expect(target).toMatchObject({ type: 'demo', id: 'custom-xyz' });
    expect(metadata).toEqual({ scenarioId: 'custom-xyz', initialMode: 'reception' });
  });
});
