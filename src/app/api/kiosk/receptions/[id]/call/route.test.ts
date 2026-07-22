/**
 * kiosk 取次ルート（`/api/kiosk/receptions/:id/call`）の実行時配線テスト (issue #374)。
 *
 * 検証:
 *   - kiosk セッション必須（無ければ 403、取次を実行しない）。
 *   - 保存済みルートがあれば Orchestrator の段階実行結果で状態確定し、応答に stages[] を付す。
 *   - ルート未設定（fail-open）は従来どおり単発 Mock（startCall 既定 adapter）へ委ね、stages を付さない。
 *   - 取次実行が失敗しても従来応答へ倒す（fail-open）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const denyWithoutKioskSession = vi.fn();
const startCall = vi.fn();
const executeRoutedCall = vi.fn();
const routedCallAdapter = vi.fn();

vi.mock('@/lib/kiosk/session-guard', () => ({
  denyWithoutKioskSession: (...a: unknown[]) => denyWithoutKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  startCall: (...a: unknown[]) => startCall(...a),
}));
vi.mock('@/lib/routing/call-execution', () => ({
  executeRoutedCall: (...a: unknown[]) => executeRoutedCall(...a),
  routedCallAdapter: (...a: unknown[]) => routedCallAdapter(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));

import { POST } from './route';

function call(id = 'rec-1') {
  return POST(new Request('http://localhost/api/kiosk/receptions/rec-1/call', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  denyWithoutKioskSession.mockResolvedValue(null);
  routedCallAdapter.mockReturnValue({ call: vi.fn() });
});

describe('POST /api/kiosk/receptions/:id/call', () => {
  it('kiosk セッションが無ければ 403（取次を実行しない）', async () => {
    denyWithoutKioskSession.mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    const res = await call();
    expect(res.status).toBe(403);
    expect(executeRoutedCall).not.toHaveBeenCalled();
    expect(startCall).not.toHaveBeenCalled();
  });

  it('保存ルートがあれば段階実行結果で確定し、応答に stages[] を付す', async () => {
    executeRoutedCall.mockResolvedValue({
      status: 'connected',
      stages: [
        { key: 'personal', status: 'done' },
        { key: 'department', status: 'done' },
      ],
      outcome: { status: 'connected', reason: 'stopped', trace: [], hops: 2, ledger: new Set() },
    });
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('connected');
    expect(body.stages).toEqual([
      { key: 'personal', status: 'done' },
      { key: 'department', status: 'done' },
    ]);
    // startCall は routedCallAdapter で駆動される（既定 Mock ではない）。
    expect(routedCallAdapter).toHaveBeenCalled();
    expect(startCall).toHaveBeenCalledWith('rec-1', expect.anything());
  });

  it('ルート未設定（fail-open）は従来応答（stages なし）へ倒し、既定 adapter で startCall する', async () => {
    executeRoutedCall.mockResolvedValue(null);
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('connected');
    expect(body).not.toHaveProperty('stages');
    // 既定 adapter（undefined）で startCall する。
    expect(startCall).toHaveBeenCalledWith('rec-1', undefined);
    expect(routedCallAdapter).not.toHaveBeenCalled();
  });

  it('取次実行が例外でも fail-open（従来応答）', async () => {
    executeRoutedCall.mockRejectedValue(new Error('boom'));
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('stages');
    expect(startCall).toHaveBeenCalledWith('rec-1', undefined);
  });

  it('startCall がエラーなら従来どおりエラー応答（stages を付さない）', async () => {
    executeRoutedCall.mockResolvedValue({
      status: 'connected',
      stages: [{ key: 'personal', status: 'done' }],
      outcome: { status: 'connected', reason: 'stopped', trace: [], hops: 1, ledger: new Set() },
    });
    startCall.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'reception not found' } });

    const res = await call();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).not.toHaveProperty('stages');
  });
});
