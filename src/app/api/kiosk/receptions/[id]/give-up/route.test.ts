/**
 * 端末が待つのをやめたことをサーバへ伝える (#743 AC3)。
 *
 * ## 事実
 *
 * `CALL_STATUS_POLL_MAX_MS`（5 分）に達したときの諦めは**クライアントの dispatch だけ**で、
 * サーバへ何も送っていなかった。受付は `'calling'` のまま残り、**取次は hop 上限まで
 * 進み続ける** ── iPad は諦めたのに社内の電話は鳴り続ける。
 *
 * ここは「来訪者はもう待っていない」という**意思をサーバへ届ける**ための最小の経路。
 * 鳴っている通話を切る操作は含まない（外部副作用＝停止境界。#743 の残りとして分離）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const markCallFailed = vi.fn();
const getReception = vi.fn();
const denyWithoutKioskSession = vi.fn();
const hangUpIfRinging = vi.fn();

vi.mock('@/lib/data-stores/reception-store', () => ({
  markCallFailed: (...a: unknown[]) => markCallFailed(...a),
  getReception: (...a: unknown[]) => getReception(...a),
}));
vi.mock('@/lib/routing/hang-up', () => ({
  hangUpIfRinging: (...a: unknown[]) => hangUpIfRinging(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'TEST-tenant', siteId: 'TEST-site' }),
}));
vi.mock('@/lib/kiosk/session-guard', () => ({
  denyWithoutKioskSession: () => denyWithoutKioskSession(),
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'rec-1' });
const request = () => new Request('https://reception.test/x', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  denyWithoutKioskSession.mockResolvedValue(null);
  getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'calling', kioskId: 'k1' } });
  markCallFailed.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'failed' } });
  hangUpIfRinging.mockResolvedValue({ kind: 'terminated' });
});

describe('POST /api/kiosk/receptions/:id/give-up (#743)', () => {
  /**
   * 🔴 **これが本体。** 受付を終端させることで、以降の hop が
   * `decideRoutingStop` に弾かれる（`dialNextHop` は撃つ前に受付状態を見る）。
   */
  it('🔴 受付を終端させ、以降の取次を止める', async () => {
    const res = await POST(request(), { params });
    expect(res.status).toBe(200);
    expect(markCallFailed).toHaveBeenCalledWith('rec-1', 'client_timeout');
  });

  it('端末セッションが無ければ受け付けない', async () => {
    denyWithoutKioskSession.mockResolvedValue(
      new Response('forbidden', { status: 403 }) as never,
    );
    const res = await POST(request(), { params });
    expect(res.status).toBe(403);
    expect(markCallFailed).not.toHaveBeenCalled();
  });

  /**
   * 🔴 既に終端している受付を蒸し返さない。担当者が応答して `connected` になった直後に
   * 端末側の上限が来ることがある ── そこで `failed` を書くと**繋がったのに失敗になる**。
   */
  it('🔴 すでに終端していれば何も書かない', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected', kioskId: 'k1' } });
    const res = await POST(request(), { params });
    expect(res.status).toBe(200);
    expect(markCallFailed).not.toHaveBeenCalled();
  });

  it('存在しない受付は 404', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await POST(request(), { params });
    expect(res.status).toBe(404);
    expect(markCallFailed).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **端末を待たせない。** ここが 5xx を返しても来訪者にできることは無いので、
   * 書けなかったことを理由に端末側の遷移を止めない。
   */
  it('🔴 書き込みに失敗しても端末を止めない（200 で返す）', async () => {
    markCallFailed.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'x' } });
    const res = await POST(request(), { params });
    expect(res.status).toBe(200);
  });
});

/**
 * 鳴っている通話も切る（2026-08-21 のユーザー判断 / #743 AC2 後半）。
 *
 * 受付を終端させても、**既に鳴り始めた通話はそのまま鳴り続ける**（呼出予算が経過するまで）。
 * 担当者は出てしまい、そこに来訪者は居ない ──「無人の呼び出し」。
 */
describe('鳴っている通話を切る (#743 AC2)', () => {
  it('🔴 受付の provider 通話を切りに行く', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { id: 'rec-1', state: 'calling', kioskId: 'k1', providerCallId: 'TEST-uuid' },
    });
    await POST(request(), { params });
    expect(hangUpIfRinging).toHaveBeenCalledWith('TEST-tenant', 'TEST-uuid');
  });

  /**
   * 🔴 **受付を止めてから切る。** 逆順にすると、切断の webhook（`completed`）が
   * 受付がまだ `'calling'` のうちに届き、取次が「次の手へ進む」と判断しうる。
   */
  it('🔴 受付を終端させてから切る（順序）', async () => {
    const order: string[] = [];
    markCallFailed.mockImplementation(async () => {
      order.push('stop');
      return { ok: true, value: { id: 'rec-1', state: 'failed' } };
    });
    hangUpIfRinging.mockImplementation(async () => {
      order.push('hangup');
      return { kind: 'terminated' };
    });
    getReception.mockResolvedValue({
      ok: true,
      value: { id: 'rec-1', state: 'calling', kioskId: 'k1', providerCallId: 'TEST-uuid' },
    });
    await POST(request(), { params });
    expect(order).toEqual(['stop', 'hangup']);
  });

  /**
   * 🔴 **切断の失敗で端末を止めない。** ここが失敗しても来訪者にできることは無く、
   * 画面が「呼び出し中」のまま固まる方が悪い。呼出予算で通話は自然に終わる。
   */
  it('🔴 切断が失敗しても 200 を返す', async () => {
    hangUpIfRinging.mockResolvedValue({ kind: 'failed' });
    getReception.mockResolvedValue({
      ok: true,
      value: { id: 'rec-1', state: 'calling', kioskId: 'k1', providerCallId: 'TEST-uuid' },
    });
    const res = await POST(request(), { params });
    expect(res.status).toBe(200);
  });

  it('🔴 切断が例外でも 200 を返す', async () => {
    hangUpIfRinging.mockRejectedValue(new Error('TEST-boom'));
    getReception.mockResolvedValue({
      ok: true,
      value: { id: 'rec-1', state: 'calling', kioskId: 'k1', providerCallId: 'TEST-uuid' },
    });
    await expect(POST(request(), { params })).resolves.toBeDefined();
  });

  /** 既に終端している受付では、受付も通話も触らない。 */
  it('🔴 既に終端していれば切りにも行かない', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { id: 'rec-1', state: 'connected', kioskId: 'k1', providerCallId: 'TEST-uuid' },
    });
    await POST(request(), { params });
    expect(markCallFailed).not.toHaveBeenCalled();
    expect(hangUpIfRinging).not.toHaveBeenCalled();
  });
});
