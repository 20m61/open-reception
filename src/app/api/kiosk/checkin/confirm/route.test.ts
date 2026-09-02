/**
 * `/api/kiosk/checkin/confirm` の契約 (#736 / #98)。
 *
 * 🔴 **このルートにはテストが 1 本も無かった。** 受付セッションを作って 201 を返すという
 * 中核の振る舞いも、監査に何を書くかも、誰も縛っていなかった。
 *
 * とくに監査は `reception.connected`（**接続した**）を書いていた。この時点で呼び出しは
 * 行われていない（実際に呼ぶのは端末が続けて叩く `/call`）ので、
 * **誰も呼ばれていない受付が監査上は接続済みとして残る**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.fn();
const createReception = vi.fn();
const appendAuditLog = vi.fn();
const requireKioskSession = vi.fn();

const resolveCheckinScope = vi.fn();
vi.mock('@/lib/checkin/store', () => ({
  getCheckinService: () => ({ confirm }),
  resolveCheckinScope: (...a: unknown[]) => resolveCheckinScope(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  createReception: (...a: unknown[]) => createReception(...a),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAuditLog: (...a: unknown[]) => appendAuditLog(...a),
}));
vi.mock('@/lib/checkin/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/checkin/request')>()),
  requireKioskSession: () => requireKioskSession(),
}));

import { POST } from './route';

const SUMMARY = {
  visitorName: 'TEST-来客',
  companyName: 'TEST-商事',
  targetType: 'staff' as const,
  targetId: 'staff-seed',
  visitAt: '2026-08-21T00:00:00.000Z',
};

function request(body: unknown = { payload: 'TEST-payload' }): Request {
  return new Request('https://reception.test/api/kiosk/checkin/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireKioskSession.mockResolvedValue({ kioskId: 'TEST-kiosk' });
  resolveCheckinScope.mockResolvedValue({ tenantId: 'internal', siteId: 'default-site' });
  confirm.mockResolvedValue({ ok: true, summary: SUMMARY });
  createReception.mockResolvedValue({ ok: true, value: { id: 'rec-1' } });
  appendAuditLog.mockResolvedValue(undefined);
});

describe('POST /api/kiosk/checkin/confirm', () => {
  it('受付セッションを作り、その id を返す（端末はこれで呼び出す）', async () => {
    const res = await POST(request());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reception: { id: 'rec-1' } });
  });

  /**
   * 🔴 **ここが本体。** この時点で呼び出しは行われていない。「接続した」と書くと、
   * 誰も呼ばれていない受付が監査上は接続済みとして残る。
   */
  it('🔴 監査に「接続した」と書かない（まだ呼んでいない）', async () => {
    await POST(request());
    const entry = appendAuditLog.mock.calls[0]?.[0] as { action: string };
    expect(entry.action).not.toBe('reception.connected');
    expect(entry.action).toBe('reception.created');
  });

  it('監査は受付方法と呼び出し先種別だけを残す（PII を書かない）', async () => {
    await POST(request());
    const entry = appendAuditLog.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(entry.metadata).toEqual({ entryMethod: 'qr', targetType: 'staff' });
    const serialized = JSON.stringify(appendAuditLog.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(SUMMARY.visitorName);
    expect(serialized).not.toContain(SUMMARY.companyName);
  });

  it('端末セッションが無ければ 403（受付を作らない）', async () => {
    requireKioskSession.mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(createReception).not.toHaveBeenCalled();
  });

  it('予約が使えなければ受付を作らない', async () => {
    confirm.mockResolvedValue({ ok: false, reason: 'expired' });
    const res = await POST(request());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createReception).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it('確認サービスが落ちても 5xx を返して監査を汚さない', async () => {
    confirm.mockRejectedValue(new Error('TEST-down'));
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

/**
 * 端末が台帳に無ければ予約を引かせない (#736)。
 *
 * 🔴 scope は「その端末がどの予約を見られるか」を決める。既定テナントへ倒すと、
 * **未登録の端末が他テナントの予約を引ける**。
 */
describe('未登録の端末は拒否する (#736)', () => {
  it('🔴 scope が解決できなければ 403 で、予約も受付も触らない', async () => {
    resolveCheckinScope.mockResolvedValue(undefined);
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(confirm).not.toHaveBeenCalled();
    expect(createReception).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it('端末台帳の scope をそのまま使う（既定へ差し替えない）', async () => {
    resolveCheckinScope.mockResolvedValue({ tenantId: 'tenant-b', siteId: 'site-9' });
    await POST(request());
    expect(confirm).toHaveBeenCalledWith('tenant-b', 'site-9', 'TEST-payload');
  });
});
