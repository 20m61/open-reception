/**
 * /api/admin/demo/publications/:id — 状態遷移（set_status/publish/rollback）と削除 (issue #363 Inc3)。
 * 認可（#91）: GET read / PATCH・DELETE write。誤 target 公開防止・rollback を固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import type { DemoScenario } from '@/domain/demo-studio/scenario';
import type { Kiosk } from '@/domain/kiosk/types';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();
const getSavedDemoScenario = vi.fn<(id: string) => Promise<DemoScenario | undefined>>();
const listKiosks = vi.fn<() => Promise<Kiosk[]>>();

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
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  listKiosks: () => listKiosks(),
}));

import { GET, PATCH, DELETE } from './route';
import {
  __resetDemoPublications,
  getDemoPublication,
  saveDemoPublication,
} from '@/domain/demo-studio/publication-store';
import { createPublication } from '@/domain/demo-studio/publication';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
function scenario(id: string): DemoScenario {
  return { id, name: 'デモ', initialMode: 'reception', visitorInputs: [], simulatedResults: {} };
}
function kiosk(id: string, enabled = true): Kiosk {
  return { id, displayName: id, enabled };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(new Request(`http://x/api/admin/demo/publications/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), ctx(id));
}

// tenant-demo（defaultTenantId）が siteId になる。
const SITE = 'tenant-demo';

async function seedDraft(id = 'pub-1', scenarioId = 'custom-x') {
  await saveDemoPublication(createPublication(id, scenarioId, '2026-07-22T00:00:00.000Z'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetDemoPublications();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
  getSavedDemoScenario.mockImplementation(async (id) => (id === 'custom-x' ? scenario('custom-x') : undefined));
  listKiosks.mockResolvedValue([kiosk('kiosk-a'), kiosk('kiosk-b'), kiosk('kiosk-off', false)]);
});

describe('PATCH set_status', () => {
  it('draft→test に遷移し監査する', async () => {
    await seedDraft();
    const res = await patch('pub-1', { op: 'set_status', status: 'test' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('test');
    expect((await getDemoPublication('pub-1'))?.status).toBe('test');
    const [action, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(action).toBe('reception.demo_status_changed');
    expect(metadata).toMatchObject({ event: 'status_changed', status: 'test' });
  });
  it('set_status で published へは 422', async () => {
    await seedDraft();
    expect((await patch('pub-1', { op: 'set_status', status: 'published' })).status).toBe(422);
  });
  it('viewer は 403', async () => {
    await seedDraft();
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await patch('pub-1', { op: 'set_status', status: 'test' })).status).toBe(403);
  });
});

describe('PATCH publish（誤 Site/Kiosk 公開防止）', () => {
  it('許可された Kiosk への公開は 200・version1・published', async () => {
    await seedDraft();
    const res = await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'kiosk-a' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('published');
    expect(body.currentVersion).toBe(1);
    expect(body.target).toEqual({ siteId: SITE, kioskId: 'kiosk-a' });
    const [action, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(action).toBe('reception.demo_published');
    expect(metadata).toMatchObject({ event: 'published', kioskId: 'kiosk-a', version: '1' });
  });
  it('存在しない Kiosk への公開は 422（fail-closed）', async () => {
    await seedDraft();
    const res = await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'ghost' } });
    expect(res.status).toBe(422);
    expect((await getDemoPublication('pub-1'))?.status).toBe('draft');
  });
  it('無効化された Kiosk への公開は 422（母集合から除外）', async () => {
    await seedDraft();
    expect((await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'kiosk-off' } })).status).toBe(422);
  });
  it('siteId が食い違う公開は 422', async () => {
    await seedDraft();
    expect((await patch('pub-1', { op: 'publish', target: { siteId: 'other-site', kioskId: 'kiosk-a' } })).status).toBe(422);
  });
  it('target 欠落は 400', async () => {
    await seedDraft();
    expect((await patch('pub-1', { op: 'publish', target: { kioskId: 'kiosk-a' } })).status).toBe(400);
  });
});

describe('PATCH rollback', () => {
  it('過去 version へ rollback すると新 version として復元する', async () => {
    await seedDraft();
    // v1: kiosk-a, v2: kiosk-b
    await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'kiosk-a' } });
    await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'kiosk-b' } });
    const res = await patch('pub-1', { op: 'rollback', version: 1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentVersion).toBe(3);
    expect(body.target).toEqual({ siteId: SITE, kioskId: 'kiosk-a' });
    expect(body.versions).toHaveLength(3);
    const [action, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(action).toBe('reception.demo_rolled_back');
    expect(metadata).toMatchObject({ event: 'rolled_back', rolledBackFrom: '1', version: '3' });
  });
  it('存在しない version は 422', async () => {
    await seedDraft();
    await patch('pub-1', { op: 'publish', target: { siteId: SITE, kioskId: 'kiosk-a' } });
    expect((await patch('pub-1', { op: 'rollback', version: 99 })).status).toBe(422);
  });
});

describe('GET / DELETE', () => {
  it('存在しない id は 404', async () => {
    expect((await GET(new Request('http://x'), ctx('nope'))).status).toBe(404);
  });
  it('DELETE は削除し監査する', async () => {
    await seedDraft();
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('pub-1'));
    expect(res.status).toBe(200);
    expect(await getDemoPublication('pub-1')).toBeUndefined();
    const [action, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(action).toBe('reception.demo_publication_deleted');
    expect(metadata).toMatchObject({ event: 'publication_deleted' });
  });
  it('未知の op は 400', async () => {
    await seedDraft();
    expect((await patch('pub-1', { op: 'nope' })).status).toBe(400);
  });
});
