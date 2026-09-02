/**
 * status ルート（受付端末向け状態ポーリング）の単体テスト。
 * 認可（kiosk セッション必須・端末一致 = issue #342 の受付所有権チェック）を検証する。
 * issue #348: 受付作成時の kioskId が認証済みセッション由来で確定するようになったため、
 * 同一端末からの status 取得は 403 にならないこと、別端末からは引き続き 403 になることを
 * 固定する（回帰防止）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const getReceptionVisitorStatus = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
const markConnected = vi.fn();
const markTimeout = vi.fn();
const markCallFailed = vi.fn();
const loadCorrelation = vi.fn();

vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
  getReceptionVisitorStatus: (...a: unknown[]) => getReceptionVisitorStatus(...a),
  markConnected: (...a: unknown[]) => markConnected(...a),
  markTimeout: (...a: unknown[]) => markTimeout(...a),
  markCallFailed: (...a: unknown[]) => markCallFailed(...a),
}));
vi.mock('@/lib/routing/call-correlation', () => ({
  getCallCorrelationRepository: () => ({ get: (...a: unknown[]) => loadCorrelation(...a) }),
}));

import { GET } from './route';

function call(id = 'rec-1') {
  return GET(new Request('http://localhost/api/kiosk/receptions/rec-1/status'), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/receptions/:id/status', () => {
  it('403 when there is no valid kiosk session', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('403 when the reception belongs to a different kiosk (#342 defense preserved)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'other-kiosk' } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(getReceptionVisitorStatus).not.toHaveBeenCalled();
  });

  it('200 when the same kiosk session created the reception (#348 fix: no longer 403)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1' } });
    getReceptionVisitorStatus.mockResolvedValue({ ok: true, value: { state: 'calling' } });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ state: 'calling' });
  });
});

/**
 * 実 PSTN 通話の遅延確定の配線 (#647)。
 *
 * 🔴 `resolvePendingCall` を呼び忘れても既存テストは全部緑のまま通る（状態は返るので）。
 * 症状は「実発信の受付が永久に calling」という沈黙だけになるので、配線そのものを固定する。
 */
describe('GET /api/kiosk/receptions/:id/status — 実 PSTN の遅延確定 (#647)', () => {
  beforeEach(() => {
    getReceptionVisitorStatus.mockResolvedValue({ ok: true, value: { state: 'calling' } });
  });

  it('🔴 呼び出し中かつ providerCallId 在りなら相関を読む（＝確定を試みる）', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { kioskId: 'kiosk-1', id: 'rec-1', state: 'calling', providerCallId: 'TEST-call' },
    });
    loadCorrelation.mockResolvedValue({ voiceState: 'ringing', status: 'in_flight' });

    await call();
    expect(loadCorrelation).toHaveBeenCalledWith('TEST-call');
  });

  it('未応答の相関なら timeout として確定してから状態を返す', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { kioskId: 'kiosk-1', id: 'rec-1', state: 'calling', providerCallId: 'TEST-call' },
    });
    loadCorrelation.mockResolvedValue({ voiceState: 'no_answer', status: 'in_flight' });
    getReceptionVisitorStatus.mockResolvedValue({ ok: true, value: { state: 'timeout' } });

    const res = await call();
    expect(markTimeout).toHaveBeenCalledWith('rec-1');
    expect(await res.json()).toEqual({ state: 'timeout' });
  });

  it('🔴 ビデオ経路（providerCallId 無し）の calling には触らない', async () => {
    // ビデオビュー側の確定と二重になる。
    getReception.mockResolvedValue({
      ok: true,
      value: { kioskId: 'kiosk-1', id: 'rec-1', state: 'calling', vonageSessionId: 'sess-1' },
    });
    await call();
    expect(loadCorrelation).not.toHaveBeenCalled();
    expect(markTimeout).not.toHaveBeenCalled();
  });

  it('🔴 認可に失敗したら確定を試みない（越境要求で他人の通話を進めない）', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { kioskId: 'other-kiosk', id: 'rec-1', state: 'calling', providerCallId: 'TEST-call' },
    });
    const res = await call();
    expect(res.status).toBe(403);
    expect(loadCorrelation).not.toHaveBeenCalled();
  });

  it('🔴 相関の読み取りが落ちても状態取得は成功する（/status を巻き添えにしない）', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { kioskId: 'kiosk-1', id: 'rec-1', state: 'calling', providerCallId: 'TEST-call' },
    });
    loadCorrelation.mockRejectedValue(new Error('backend unavailable'));

    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'calling' });
  });
});
