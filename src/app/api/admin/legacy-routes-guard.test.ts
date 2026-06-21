/**
 * 旧 admin API ルートへの権限ガード横展開の単体テスト (issue #91, increment 2)。
 *
 * inc1 の `src/lib/admin/guard.ts`（requireActor / assertCanRead/Write）を、tenantId を
 * URL/body で受け取らない旧ルート（部署・担当者・端末・アセット・モーション・音声・
 * 受付ログ・監査ログ）へ適用した結果を、認可境界の観点で検証する:
 *   - 未認証 → 401
 *   - viewer の書込 → 403（読込は 200）
 *   - 既定テナント外の actor → 403（テナント越境分離）
 *   - 適切なロール → 200/201
 *
 * 機能・レスポンス形は inc1 から変えていないため、ここでは認可前段のみを焦点にする。
 * 既定テナント ID は env 未設定時 'default'（buildActorConfig）。actor もそれに合わせる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  // guard.defaultAdminTenantId() が参照する。env 未設定時の既定と同じ 'default'。
  buildActorConfig: () => ({
    defaultTenantId: 'default',
    passwordRole: 'tenant_admin',
    developerEmails: new Set<string>(),
    entraUnregistered: 'deny',
  }),
}));
vi.mock('@/lib/mock-backend/reception-log-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mock-backend/reception-log-store')>();
  return { ...actual, appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a) };
});

import { GET as DEPT_GET, POST as DEPT_POST } from './departments/route';
import { PATCH as DEPT_PATCH } from './departments/[id]/route';
import { POST as DEPT_MOVE } from './departments/[id]/move/route';
import { POST as DEPT_REORDER } from './departments/reorder/route';
import { POST as DEPT_IMPORT } from './departments/import/route';
import { GET as STAFF_GET, POST as STAFF_POST } from './staff/route';
import { PATCH as STAFF_PATCH } from './staff/[id]/route';
import { POST as STAFF_IMPORT } from './staff/import/route';
import { GET as KIOSK_GET, POST as KIOSK_POST } from './kiosks/route';
import { POST as KIOSK_REVOKE } from './kiosks/[id]/revoke/route';
import { POST as KIOSK_RESTORE } from './kiosks/[id]/restore/route';
import { GET as ASSET_GET, POST as ASSET_POST } from './assets/route';
import { PATCH as ASSET_PATCH } from './assets/[id]/route';
import { GET as MOTION_GET, PUT as MOTION_PUT } from './motions/route';
import { GET as VOICE_GET, PUT as VOICE_PUT } from './voice/route';
import { GET as RECEPTIONS_GET } from './receptions/route';
import { GET as AUDIT_GET } from './audit/route';

const TENANT = 'default';

function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }] };
}
function viewer(): Actor {
  return { status: 'active', assignments: [{ role: 'viewer', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }] };
}
function otherTenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId('other'), siteId: null, deviceId: null }] };
}

function jsonReq(body: unknown, method = 'POST') {
  return new Request('http://localhost/api/admin/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * 読込系（GET）と書込系（変更を伴うハンドラ）を横断的に表で検証する。
 * 各ハンドラに、認可だけ通れば 200/201/400 のいずれか（=ガードで弾かれない）を返す
 * 最小の有効リクエストを与える。
 */
const READ_ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'GET /departments', call: () => DEPT_GET() },
  { name: 'GET /staff', call: () => STAFF_GET() },
  { name: 'GET /kiosks', call: () => KIOSK_GET() },
  { name: 'GET /assets', call: () => ASSET_GET() },
  { name: 'GET /motions', call: () => MOTION_GET() },
  { name: 'GET /voice', call: () => VOICE_GET() },
  { name: 'GET /receptions', call: () => RECEPTIONS_GET() },
  { name: 'GET /audit', call: () => AUDIT_GET() },
];

const WRITE_ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'POST /departments', call: () => DEPT_POST(jsonReq({ name: 'X' })) },
  { name: 'PATCH /departments/:id', call: () => DEPT_PATCH(jsonReq({ name: 'X' }, 'PATCH'), params('d1')) },
  { name: 'POST /departments/:id/move', call: () => DEPT_MOVE(jsonReq({ direction: 'up' }), params('d1')) },
  { name: 'POST /departments/reorder', call: () => DEPT_REORDER(jsonReq({ orderedIds: [] })) },
  { name: 'POST /departments/import', call: () => DEPT_IMPORT(jsonReq({ csv: 'name\nX', mode: 'preview' })) },
  { name: 'POST /staff', call: () => STAFF_POST(jsonReq({ name: 'X' })) },
  { name: 'PATCH /staff/:id', call: () => STAFF_PATCH(jsonReq({ name: 'X' }, 'PATCH'), params('s1')) },
  { name: 'POST /staff/import', call: () => STAFF_IMPORT(jsonReq({ csv: 'name\nX', mode: 'preview' })) },
  { name: 'POST /kiosks', call: () => KIOSK_POST(jsonReq({ name: 'X' })) },
  { name: 'POST /kiosks/:id/revoke', call: () => KIOSK_REVOKE(jsonReq({}), params('k1')) },
  { name: 'POST /kiosks/:id/restore', call: () => KIOSK_RESTORE(jsonReq({}), params('k1')) },
  { name: 'POST /assets', call: () => ASSET_POST(jsonReq({ name: 'X' })) },
  { name: 'PATCH /assets/:id', call: () => ASSET_PATCH(jsonReq({ enabled: true }, 'PATCH'), params('a1')) },
  { name: 'PUT /motions', call: () => MOTION_PUT(jsonReq({ default: null }, 'PUT')) },
  { name: 'PUT /voice', call: () => VOICE_PUT(jsonReq({}, 'PUT')) },
];

describe('legacy admin routes — 認証ガード (401)', () => {
  for (const r of [...READ_ROUTES, ...WRITE_ROUTES]) {
    it(`${r.name} → 401 when unauthenticated`, async () => {
      resolveAdminActor.mockResolvedValue(null);
      expect((await r.call()).status).toBe(401);
    });
  }
});

describe('legacy admin routes — テナント越境分離 (403)', () => {
  for (const r of [...READ_ROUTES, ...WRITE_ROUTES]) {
    it(`${r.name} → 403 for actor outside the default tenant`, async () => {
      resolveAdminActor.mockResolvedValue(otherTenantAdmin());
      expect((await r.call()).status).toBe(403);
    });
  }
});

describe('legacy admin routes — viewer は読込可・書込不可', () => {
  for (const r of READ_ROUTES) {
    it(`${r.name} → 200 for viewer`, async () => {
      resolveAdminActor.mockResolvedValue(viewer());
      expect((await r.call()).status).toBe(200);
    });
  }
  for (const r of WRITE_ROUTES) {
    it(`${r.name} → 403 for viewer (write forbidden)`, async () => {
      resolveAdminActor.mockResolvedValue(viewer());
      const res = await r.call();
      expect(res.status).toBe(403);
      // 認可で弾かれた書込は監査に残らない。
      expect(appendAdminAudit).not.toHaveBeenCalled();
    });
  }
});

describe('legacy admin routes — tenant_admin は認可を通過する (≠403)', () => {
  for (const r of [...READ_ROUTES, ...WRITE_ROUTES]) {
    it(`${r.name} → not 401/403 for tenant_admin`, async () => {
      resolveAdminActor.mockResolvedValue(tenantAdmin());
      const status = (await r.call()).status;
      // ガードを通過していること（機能側の 200/201/400 等は本テストの対象外）。
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });
  }
});
