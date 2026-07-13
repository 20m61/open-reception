/**
 * POST /api/platform/reconcile/devices のテスト (#290 item2 データ修復 dry-run)。
 *
 * - 昇格必須（未昇格は assertElevated の 403 をそのまま返す）。
 * - 昇格済みは端末レジストリ整合の dry-run プランを返し（mutation なし・dryRun:true）、
 *   高重要度監査 platform.data_reconcile.previewed に drift 件数のみ記録する（PII なし）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const assertElevated = vi.fn();
const planDeviceReconciliation = vi.fn();
const recordPlatformReadAudit = vi.fn();
const elevatedWriteAuditMetadata = vi.fn();

vi.mock('@/lib/platform/request', () => ({ assertElevated: (...a: unknown[]) => assertElevated(...a) }));
vi.mock('@/lib/platform/device-reconciliation', () => ({
  planDeviceReconciliation: () => planDeviceReconciliation(),
}));
vi.mock('@/lib/platform/read-audit', () => ({
  recordPlatformReadAudit: (...a: unknown[]) => recordPlatformReadAudit(...a),
}));
vi.mock('@/domain/auth/elevation', () => ({
  elevatedWriteAuditMetadata: (...a: unknown[]) => elevatedWriteAuditMetadata(...a),
}));

import { POST } from './route';

const PLAN = {
  adopt: [{ id: 'kiosk-new', action: 'adopt', kioskEnabled: true, targetStatus: 'active' }],
  syncStatus: [],
  deviceOnly: [{ id: 'device-x', action: 'device_only', deviceStatus: 'active' }],
  driftCount: 1,
  kioskCount: 2,
  deviceCount: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  assertElevated.mockResolvedValue({ ok: true, elevation: { sub: 'dev@example.com' } });
  planDeviceReconciliation.mockResolvedValue(PLAN);
  recordPlatformReadAudit.mockResolvedValue(undefined);
  elevatedWriteAuditMetadata.mockReturnValue({});
});

describe('POST /api/platform/reconcile/devices (#290 item2)', () => {
  it('未昇格は assertElevated の 403 をそのまま返し、整合も監査もしない', async () => {
    assertElevated.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'elevation_required' }, { status: 403 }),
    });
    const res = await POST(new Request('http://localhost/api/platform/reconcile/devices', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(planDeviceReconciliation).not.toHaveBeenCalled();
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('昇格済みは dry-run プランを返す（dryRun:true・mutation なし）', async () => {
    const res = await POST(new Request('http://localhost/api/platform/reconcile/devices', { method: 'POST' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ plan: PLAN, dryRun: true });
  });

  it('drift 件数のみを高重要度監査に記録する（PII なし・操作者は elevation.sub 帰属）', async () => {
    await POST(new Request('http://localhost/api/platform/reconcile/devices', { method: 'POST' }));
    expect(recordPlatformReadAudit).toHaveBeenCalledTimes(1);
    expect(recordPlatformReadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.data_reconcile.previewed',
        identity: 'dev@example.com',
        target: { type: 'device_registry' },
        metadata: expect.objectContaining({ driftCount: 1, adopt: 1, syncStatus: 0, deviceOnly: 1 }),
      }),
    );
  });

  it('break-glass 昇格中は severity マークを監査 metadata に含める', async () => {
    elevatedWriteAuditMetadata.mockReturnValue({ breakGlass: 'true', severity: 'high' });
    await POST(new Request('http://localhost/api/platform/reconcile/devices', { method: 'POST' }));
    expect(recordPlatformReadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ breakGlass: 'true', severity: 'high' }),
      }),
    );
  });
});
