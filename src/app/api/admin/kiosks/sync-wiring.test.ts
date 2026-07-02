/**
 * /admin/kiosks 系ルートの Device 逆方向同期の配線テスト (issue #284 inc1)。
 *
 * 作成（POST /api/admin/kiosks）・失効/再有効化（POST :id/revoke|restore）の成功時に
 * kiosk → Device の即時写像（syncKioskToDevice）を呼ぶこと、失敗時は呼ばないことを検証する。
 * 認可・監査の既存挙動は変えない（監査は既存 kiosk.* アクションのまま）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kiosk } from '@/domain/kiosk/types';

const createKiosk = vi.fn();
const setKioskEnabled = vi.fn();
const listKiosks = vi.fn();
const syncKioskToDevice = vi.fn();
const appendAdminAudit = vi.fn();
const recordDangerAction = vi.fn();
const requireActor = vi.fn();

vi.mock('@/lib/kiosk/kiosk-store', () => ({
  createKiosk: (...a: unknown[]) => createKiosk(...a),
  setKioskEnabled: (...a: unknown[]) => setKioskEnabled(...a),
  listKiosks: (...a: unknown[]) => listKiosks(...a),
}));
vi.mock('@/lib/kiosk/device-sync', () => ({
  syncKioskToDevice: (...a: unknown[]) => syncKioskToDevice(...a),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));
vi.mock('@/lib/admin/audit', () => ({
  recordDangerAction: (...a: unknown[]) => recordDangerAction(...a),
}));
vi.mock('@/lib/admin/guard', () => ({
  requireActor: (...a: unknown[]) => requireActor(...a),
  assertCanRead: () => undefined,
  assertCanWrite: () => undefined,
  defaultAdminTenantId: () => 'internal',
  toGuardResponse: () => new Response(null, { status: 401 }),
}));

import { POST as createRoute } from './route';
import { POST as revokeRoute } from './[id]/revoke/route';
import { POST as restoreRoute } from './[id]/restore/route';

const KIOSK: Kiosk = { id: 'kiosk-1', displayName: '受付端末1', enabled: true };

function postJson(body: unknown): Request {
  return new Request('http://localhost/api/admin/kiosks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue({ status: 'active', assignments: [] });
  createKiosk.mockResolvedValue({ ok: true, value: KIOSK });
  setKioskEnabled.mockResolvedValue({ ok: true, value: { ...KIOSK, enabled: false } });
});

describe('POST /api/admin/kiosks (#284 inc1 作成時の即時写像)', () => {
  it('作成成功時に Device へ即時同期する', async () => {
    const res = await createRoute(postJson({ displayName: '受付端末1' }));
    expect(res.status).toBe(201);
    expect(syncKioskToDevice).toHaveBeenCalledWith(KIOSK);
    // 監査は既存の kiosk.created のまま（新 AuditAction は増やさない）。
    expect(appendAdminAudit).toHaveBeenCalledWith('kiosk.created', { type: 'kiosk', id: 'kiosk-1' });
  });

  it('作成失敗時は同期しない', async () => {
    createKiosk.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_input', message: 'displayName is required' },
    });
    await createRoute(postJson({}));
    expect(syncKioskToDevice).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/kiosks/:id/revoke|restore (#284 inc1 setEnabled の即時写像)', () => {
  it('失効成功時に Device へ即時同期する（enabled=false → revoked 写像は service 側）', async () => {
    const revoked = { ...KIOSK, enabled: false };
    setKioskEnabled.mockResolvedValue({ ok: true, value: revoked });
    const res = await revokeRoute(new Request('http://localhost'), params('kiosk-1'));
    expect(res.status).toBe(200);
    expect(setKioskEnabled).toHaveBeenCalledWith('kiosk-1', false);
    expect(syncKioskToDevice).toHaveBeenCalledWith(revoked);
  });

  it('再有効化成功時に Device へ即時同期する', async () => {
    setKioskEnabled.mockResolvedValue({ ok: true, value: KIOSK });
    const res = await restoreRoute(new Request('http://localhost'), params('kiosk-1'));
    expect(res.status).toBe(200);
    expect(setKioskEnabled).toHaveBeenCalledWith('kiosk-1', true);
    expect(syncKioskToDevice).toHaveBeenCalledWith(KIOSK);
  });

  it('対象なし（not_found）は同期しない', async () => {
    setKioskEnabled.mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'kiosk not found' },
    });
    await revokeRoute(new Request('http://localhost'), params('kiosk-x'));
    await restoreRoute(new Request('http://localhost'), params('kiosk-x'));
    expect(syncKioskToDevice).not.toHaveBeenCalled();
  });
});
