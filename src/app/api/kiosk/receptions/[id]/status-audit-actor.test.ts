/**
 * 実 PSTN 経路で確定したときの監査 actor (#646 レビュー (e))。
 *
 * 🔴 **既定の `kiosk:<id>` にすると「端末が検知した」ことになる。** この経路の確定は
 * 担当者側の行動（DTMF の意思表示、または Vonage の応答）に由来するので、監査が
 * 誰の行動か言えなくなる。担当者が DTMF で承諾できるようになった時点で実害が出る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const markConnected = vi.fn();
const markTimeout = vi.fn();
const markCallFailed = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));
const getReception = vi.fn();
const getReceptionVisitorStatus = vi.fn();
const correlationGet = vi.fn();

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
  getReceptionVisitorStatus: (...a: unknown[]) => getReceptionVisitorStatus(...a),
  markConnected: (...a: unknown[]) => markConnected(...a),
  markTimeout: (...a: unknown[]) => markTimeout(...a),
  markCallFailed: (...a: unknown[]) => markCallFailed(...a),
}));
vi.mock('@/lib/routing/call-correlation', () => ({
  getCallCorrelationRepository: () => ({ get: correlationGet }),
}));

import { GET } from './status/route';

const RECEPTION = {
  id: 'rec-1',
  kioskId: 'kiosk-1',
  state: 'calling',
  providerCallId: 'TEST-call-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  getReception.mockResolvedValue({ ok: true, value: RECEPTION });
  getReceptionVisitorStatus.mockResolvedValue({ ok: true, value: { state: 'connected' } });
  markConnected.mockResolvedValue({ ok: true });
});

const get = () =>
  GET(new Request('http://localhost/api/kiosk/receptions/rec-1/status'), {
    params: Promise.resolve({ id: 'rec-1' }),
  });

describe('実 PSTN 経路の確定を監査へ残すとき (#646)', () => {
  it("🔴 応答の actor は 'staff' ── 端末が検知したことにしない", async () => {
    correlationGet.mockResolvedValue({ voiceState: 'staff_coming', status: 'in_flight' });
    await get();
    expect(markConnected).toHaveBeenCalledWith('rec-1', 'staff');
  });

  it('未確定なら何も記録しない', async () => {
    correlationGet.mockResolvedValue({ voiceState: 'ringing', status: 'in_flight' });
    await get();
    expect(markConnected).not.toHaveBeenCalled();
    expect(markTimeout).not.toHaveBeenCalled();
  });
});
