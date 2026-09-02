/**
 * QR 受付が「確認 → 実際に呼び出す」を通すこと (#736 Gate A)。
 *
 * 🔴 **ここが繋がっていなかった。** `/api/kiosk/checkin/confirm` は受付セッションを作って
 * 201 を返すだけで、`/api/kiosk/receptions/:id/call` は**一度も呼ばれなかった**。
 * それでも端末は「担当者を呼び出しています…」→「受付が完了しました」と表示していた。
 *
 * 判断（応答 → 来訪者へ伝えること）は `checkinCallOutcomeFrom` が固定している。
 * ここが固定するのは**順序と、呼ばなかったときに完了にしないこと**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmAndCall } from './place-call';

const fetchFn = vi.fn();
const calls: string[] = [];

function ok(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  fetchFn.mockImplementation(async (url: string) => {
    calls.push(url);
    if (url.includes('/checkin/confirm')) return ok({ reception: { id: 'rec-1' } }, 201);
    return ok({ state: 'connected' });
  });
});

describe('confirmAndCall (#736)', () => {
  it('🔴 確認のあとに実際の呼び出しを行う', async () => {
    const result = await confirmAndCall('TEST-payload', { fetchFn });
    expect(calls).toEqual([
      '/api/kiosk/checkin/confirm',
      '/api/kiosk/receptions/rec-1/call',
    ]);
    expect(result).toEqual({ kind: 'connected' });
  });

  it('🔴 確認に失敗したら呼び出さない（存在しない受付を呼ばない）', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      return ok({ error: 'expired' }, 400);
    });
    const result = await confirmAndCall('TEST-payload', { fetchFn });
    expect(calls).toEqual(['/api/kiosk/checkin/confirm']);
    expect(result).toEqual({ kind: 'failed', reason: 'invalid' });
  });

  /**
   * 🔴 受付 ID が無ければ呼びようがない。**完了として扱わない** ── 握り潰すと、
   * 呼ばれていないのに来訪者が「受付完了」を見て立ち去る。
   */
  it('🔴 受付 ID を得られなければ完了にしない', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      return ok({}, 201);
    });
    const result = await confirmAndCall('TEST-payload', { fetchFn });
    expect(result).toEqual({ kind: 'failed', reason: 'server' });
    expect(calls).toHaveLength(1);
  });

  it('🔴 呼び出しが未応答なら完了にしない', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/checkin/confirm')) return ok({ reception: { id: 'rec-1' } }, 201);
      return ok({ state: 'timeout' });
    });
    expect(await confirmAndCall('TEST-payload', { fetchFn })).toEqual({
      kind: 'failed',
      reason: 'unanswered',
    });
  });

  it('🔴 実発信が止まっていれば取り次げないと伝える', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/checkin/confirm')) return ok({ reception: { id: 'rec-1' } }, 201);
      return ok({ error: 'unrouted' }, 503);
    });
    expect(await confirmAndCall('TEST-payload', { fetchFn })).toEqual({
      kind: 'failed',
      reason: 'unrouted',
    });
  });

  it('実 PSTN の呼び出し中は受付 ID を返して待たせる（完了にしない）', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/checkin/confirm')) return ok({ reception: { id: 'rec-1' } }, 201);
      return ok({ state: 'calling' });
    });
    expect(await confirmAndCall('TEST-payload', { fetchFn })).toEqual({
      kind: 'pending',
      receptionId: 'rec-1',
    });
  });

  it('🔴 呼び出しの通信が切れても完了にしない', async () => {
    fetchFn.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/checkin/confirm')) return ok({ reception: { id: 'rec-1' } }, 201);
      throw new Error('TEST-network');
    });
    expect(await confirmAndCall('TEST-payload', { fetchFn })).toEqual({
      kind: 'failed',
      reason: 'network',
    });
  });

  it('確認の通信が切れたら通信断として扱う', async () => {
    fetchFn.mockRejectedValue(new Error('TEST-network'));
    expect(await confirmAndCall('TEST-payload', { fetchFn })).toEqual({
      kind: 'failed',
      reason: 'network',
    });
  });
});
