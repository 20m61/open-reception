/**
 * /api/admin/demo/publications/:id/share — 公開共有トークンの発行/失効 (issue #363 Inc3・公開モデル)。
 * published のみ発行可・高エントロピー・失効可・発行/失効を監査（PII/トークン値なし）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<AuditLog>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({ defaultTenantId: 'tenant-demo' }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...args: unknown[]) => appendAdminAudit(...args),
}));

import { POST, DELETE } from './route';
import {
  __resetDemoPublications,
  getDemoPublication,
  saveDemoPublication,
} from '@/domain/demo-studio/publication-store';
import { createPublication, publish } from '@/domain/demo-studio/publication';
import { isValidShareTokenValue, isShareTokenActive } from '@/domain/demo-studio/share-token';

function actorWith(role: Actor['assignments'][number]['role']): Actor {
  const tenantId = role === 'developer' ? null : asTenantId('tenant-demo');
  return { status: 'active', assignments: [{ role, tenantId, siteId: null, deviceId: null }] };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const TARGET = { siteId: 'tenant-demo', kioskId: 'kiosk-a' };

async function seedPublished(id = 'pub-1') {
  const draft = createPublication(id, 'custom-x', '2026-07-22T00:00:00.000Z');
  const r = publish(
    draft,
    { id: 'custom-x', name: 'デモ', initialMode: 'reception', visitorInputs: [], simulatedResults: {} },
    TARGET,
    [TARGET],
    '2026-07-22T00:00:00.000Z',
  );
  if (!r.ok) throw new Error('setup');
  await saveDemoPublication(r.publication);
}
async function seedDraft(id = 'pub-draft') {
  await saveDemoPublication(createPublication(id, 'custom-x', '2026-07-22T00:00:00.000Z'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetDemoPublications();
  appendAdminAudit.mockResolvedValue({} as AuditLog);
  resolveAdminActor.mockResolvedValue(actorWith('tenant_admin'));
});

describe('POST share（発行）', () => {
  it('published に高エントロピートークンを発行し監査（トークン値は監査に載せない）', async () => {
    await seedPublished();
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('pub-1'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(isValidShareTokenValue(body.token)).toBe(true);
    expect(body.expiresAt).toBeDefined();
    // 監査 metadata にトークン値が入っていないこと（PII/secret 最小化）。
    const [, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(metadata).toMatchObject({ event: 'share_issued' });
    expect(JSON.stringify(metadata)).not.toContain(body.token);
  });
  it('draft/test には発行できない（422）', async () => {
    await seedDraft();
    expect((await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('pub-draft'))).status).toBe(422);
  });
  it('viewer は 403', async () => {
    await seedPublished();
    resolveAdminActor.mockResolvedValue(actorWith('viewer'));
    expect((await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('pub-1'))).status).toBe(403);
  });
  it('存在しない publication は 404', async () => {
    expect((await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('nope'))).status).toBe(404);
  });
});

describe('DELETE share（失効）', () => {
  it('失効させると share.revokedAt が刻まれ以後 active でない', async () => {
    await seedPublished();
    await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('pub-1'));
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('pub-1'));
    expect(res.status).toBe(200);
    const pub = await getDemoPublication('pub-1');
    expect(pub?.share?.revokedAt).toBeDefined();
    expect(isShareTokenActive(pub!.share!, Date.now())).toBe(false);
    const [, , metadata] = appendAdminAudit.mock.calls.at(-1)!;
    expect(metadata).toMatchObject({ event: 'share_revoked' });
  });
  it('共有が無い publication の失効は 404', async () => {
    await seedPublished();
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('pub-1'))).status).toBe(404);
  });
});
