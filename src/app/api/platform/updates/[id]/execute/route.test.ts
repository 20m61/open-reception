/**
 * POST /api/platform/updates/[id]/execute のテスト (#290 item1)。
 *
 * 昇格必須・高重要度監査・dry-run 前提。実 deployer 未配線（外部待ち #195/#65）の間は dry-run のみ
 * 利用可で、実行要求は 503 deploy_unavailable（mock を本番実行に流用しない）。mock deployer を注入
 * したときの実行/失敗/永続化を検証する。ドメイン純関数（plan/遷移）は実物を使う。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { UpdateStatus } from '@/domain/platform/update-status';

const assertElevated = vi.fn();
const listUpdateStatuses = vi.fn<() => Promise<UpdateStatus[]>>();
const putUpdateStatus = vi.fn();
const getUpdateDeployer = vi.fn();
const recordDangerAction = vi.fn();
const elevatedWriteAuditMetadata = vi.fn();

vi.mock('@/lib/platform/request', () => ({ assertElevated: (...a: unknown[]) => assertElevated(...a) }));
vi.mock('@/lib/platform/update-status-store', () => ({
  listUpdateStatuses: () => listUpdateStatuses(),
  putUpdateStatus: (...a: unknown[]) => putUpdateStatus(...a),
}));
vi.mock('@/lib/platform/update-deployer', () => ({ getUpdateDeployer: () => getUpdateDeployer() }));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (...a: unknown[]) => recordDangerAction(...a) }));
vi.mock('@/domain/auth/elevation', () => ({
  elevatedWriteAuditMetadata: (...a: unknown[]) => elevatedWriteAuditMetadata(...a),
}));

import { POST } from './route';

const STATUS: UpdateStatus = {
  id: 'up-1',
  scope: 'tenant',
  tenantId: 'acme',
  component: 'kiosk-app',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  state: 'update_available',
  checkedAt: '2026-07-01T00:00:00.000Z',
  updatedBy: 'platform:op',
};

const req = (body: unknown) =>
  new Request('http://localhost/api/platform/updates/up-1/execute', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const ctx = (id = 'up-1') => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  assertElevated.mockResolvedValue({ ok: true, elevation: { sub: 'dev@example.com' } });
  listUpdateStatuses.mockResolvedValue([STATUS]);
  putUpdateStatus.mockResolvedValue(undefined);
  getUpdateDeployer.mockReturnValue(null); // 既定: 実 deployer 未配線
  recordDangerAction.mockResolvedValue(undefined);
  elevatedWriteAuditMetadata.mockReturnValue({});
});

describe('POST /api/platform/updates/[id]/execute (#290 item1)', () => {
  it('未昇格は 403（実行も監査もしない）', async () => {
    assertElevated.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'elevation_required' }, { status: 403 }) });
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(403);
    expect(listUpdateStatuses).not.toHaveBeenCalled();
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('不正な action は 400', async () => {
    const res = await POST(req({ action: 'delete' }), ctx());
    expect(res.status).toBe(400);
    expect(putUpdateStatus).not.toHaveBeenCalled();
  });

  it('存在しない id は 404', async () => {
    const res = await POST(req({ action: 'apply' }), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('実行不可な遷移（up_to_date への apply）は 400', async () => {
    listUpdateStatuses.mockResolvedValue([{ ...STATUS, state: 'up_to_date', currentVersion: '1.1.0' }]);
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(400);
    expect(putUpdateStatus).not.toHaveBeenCalled();
  });

  it('dryRun は変更せずプランを返す（監査は result:dry_run）', async () => {
    const res = await POST(req({ action: 'apply', dryRun: true }), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      plan: { id: 'up-1', action: 'apply', component: 'kiosk-app', fromVersion: '1.0.0', toVersion: '1.1.0' },
      dryRun: true,
    });
    expect(putUpdateStatus).not.toHaveBeenCalled();
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.update.executed',
        actor: 'platform:dev@example.com',
        metadata: expect.objectContaining({ result: 'dry_run', dryRun: true, toVersion: '1.1.0' }),
      }),
    );
  });

  it('実 deployer 未配線の実行要求は 503 deploy_unavailable（永続化しない・監査は残す）', async () => {
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'deploy_unavailable' });
    expect(putUpdateStatus).not.toHaveBeenCalled();
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'deploy_unavailable' }) }),
    );
  });

  it('mock deployer 成功時は状態遷移を永続化して返す（audit-first で結果を記録）', async () => {
    getUpdateDeployer.mockReturnValue({ deploy: vi.fn().mockResolvedValue({ ok: true }) });
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: expect.objectContaining({ id: 'up-1', currentVersion: '1.1.0', state: 'up_to_date' }),
      result: { ok: true },
    });
    expect(putUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: '1.1.0', state: 'up_to_date', updatedBy: 'dev@example.com' }),
    );
    // audit-first: 実デプロイの前に initiated を、完了後に succeeded を記録する。
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'initiated' }) }),
    );
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'succeeded' }) }),
    );
  });

  it('mock deployer 失敗時は state=failed で永続化し result.ok=false を返す', async () => {
    getUpdateDeployer.mockReturnValue({ deploy: vi.fn().mockResolvedValue({ ok: false }) });
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ result: { ok: false }, status: expect.objectContaining({ state: 'failed' }) });
    expect(putUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', currentVersion: '1.0.0' }));
  });

  it('永続化失敗は補償監査（store_failed）+ 500', async () => {
    getUpdateDeployer.mockReturnValue({ deploy: vi.fn().mockResolvedValue({ ok: true }) });
    putUpdateStatus.mockRejectedValue(new Error('backend down'));
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(500);
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'store_failed' }) }),
    );
  });

  it('rollback は toVersion を対象にプランする', async () => {
    const res = await POST(req({ action: 'rollback', toVersion: '0.9.0', dryRun: true }), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      plan: { action: 'rollback', toVersion: '0.9.0', fromVersion: '1.0.0' },
    });
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.update.rolled_back' }),
    );
  });
});
