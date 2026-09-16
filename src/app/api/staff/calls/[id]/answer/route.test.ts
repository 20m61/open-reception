/**
 * 担当者応答ルートの単体テスト。
 * 認可（応答トークン・受付一致）・状態（calling 必須）・secret 非漏えい・正常系を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetSecretUnavailableLog } from '@/lib/auth/secret-unavailable';

const getReception = vi.fn();
const markConnected = vi.fn();
const resolveVonageSessionService = vi.fn();
const getVonagePublicConfigForTenant = vi.fn();
const readAnswerToken = vi.fn();

vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
  markConnected: (...a: unknown[]) => markConnected(...a),
}));
vi.mock('@/lib/call/adapter-factory', () => ({
  resolveVonageSessionService: (...a: unknown[]) => resolveVonageSessionService(...a),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  getVonagePublicConfigForTenant: (...a: unknown[]) => getVonagePublicConfigForTenant(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
const getAnswerSecret = vi.fn(() => 'TEST-answer-secret');
vi.mock('@/lib/call/answer-token', () => ({
  readAnswerToken: (...a: unknown[]) => readAnswerToken(...a),
  getAnswerSecret: () => getAnswerSecret(),
}));

import { POST } from './route';

function call(id = 'rec-1', token: string | undefined = 'tok') {
  return POST(
    new Request('http://localhost/api/staff/calls/rec-1/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` は呼び出し履歴だけを消し、**実装は残る**。
  // 鍵を throw させるテストの実装が次のテストへ漏れないよう、毎回立て直す。
  getAnswerSecret.mockImplementation(() => 'TEST-answer-secret');
  readAnswerToken.mockResolvedValue({ receptionId: 'rec-1' });
  getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'calling' } });
  resolveVonageSessionService.mockReturnValue({
    issueToken: vi.fn().mockResolvedValue({ token: 'sub-token', role: 'subscriber', expiresAt: '2026-01-01T00:00:00.000Z' }),
  });
  getVonagePublicConfigForTenant.mockReturnValue({ applicationId: 'app-123' });
  markConnected.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected', callOutcome: 'connected' } });
});

describe('POST /api/staff/calls/:id/answer', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('403 when the token is for a different reception', async () => {
    readAnswerToken.mockResolvedValue({ receptionId: 'other' });
    expect((await call('rec-1')).status).toBe(403);
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    expect((await call()).status).toBe(404);
  });

  it('409 when vonage call session is unavailable', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: undefined } });
    expect((await call()).status).toBe(409);
  });

  it('409 when the reception is not in a callable state', async () => {
    // calling でなく connected でもない（例: timeout/cancelled）→ 不正遷移として 409。
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'timeout' } });
    markConnected.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'no' } });
    expect((await call()).status).toBe(409);
  });

  it('is idempotent: already-connected reception re-issues a token (rejoin)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'connected' } });
    markConnected.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'already' } });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('sub-token');
  });

  it('502 without changing state when token issuance fails', async () => {
    resolveVonageSessionService.mockReturnValue({
      issueToken: vi.fn().mockRejectedValue(new Error('jwt error')),
    });
    const res = await call();
    expect(res.status).toBe(502);
    expect(markConnected).not.toHaveBeenCalled(); // 状態を変えない
  });

  it('issues a subscriber token and marks connected — never a secret', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(markConnected).toHaveBeenCalledWith('rec-1', 'staff');
    const data = await res.json();
    expect(data).toEqual({
      applicationId: 'app-123',
      sessionId: 'sess-9',
      token: 'sub-token',
      role: 'subscriber',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(Object.keys(data).join(',').toLowerCase()).not.toMatch(/secret|private|apikey|api_key/);
    // テナント解決へ配線されていること（既定スコープの tenantId で解決）。
    expect(resolveVonageSessionService).toHaveBeenCalledWith('internal');
    expect(getVonagePublicConfigForTenant).toHaveBeenCalledWith('internal');
  });
});

/**
 * 🔴 **鍵未設定デプロイで uncaught 例外を出さない (#1123)。**
 *
 * `getAnswerSecret()` は #1021 で failClosed になったので、`CALL_ANSWER_SECRET` を
 * 入れ忘れたデプロイでは `readAnswerToken` が throw する。route が受けていないと
 * Next の既定 500 になり、(a) **未認証の誰からでも**スタックトレースを 1 リクエストにつき
 * 1 本生ませられ、(b) 正常時の 403 との差が「この環境は鍵を持っていない」のオラクルになる。
 *
 * `/api/staff/**` は middleware を `passThrough` するので、でっち上げのトークンで到達する。
 *
 * 写像先を 503 にするのは `src/app/api/kiosk/voice-transport/token/route.ts` の先例に
 * 揃えるため（「一時障害であることをクライアントへ正しく伝える」）。
 * 🔴 **403 との差は残る＝オラクルは閉じていない。** その判断は #1127。
 */
describe('鍵未設定デプロイ (#1123)', () => {
  it('🔴 鍵の解決が throw しても uncaught にせず 503 を返す', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const res = await call();
    expect(res.status).toBe(503);
  });

  it('🔴 本文に env 名・鍵名を出さない（未認証で到達できる）', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const body = await (await call()).json();
    expect(JSON.stringify(body)).not.toMatch(/CALL_ANSWER_SECRET|SECRET|dev-insecure/);
  });


  /**
   * 🔴 **catch の射程が鍵の解決だけであることを縛る (#1123)。**
   *
   * 散文は 4 route すべてで「`read*` 全体を包まない」と書いているが、**それを見張る
   * テストがどこにも無かった** —— 4 箇所同時に catch を広げる変異が unit 8778 本を
   * 素通りした（レビュー 7 周目の実測）。
   *
   * 広げると、`read*` に I/O が入った日に**大声の失敗が沈黙の 503 ＋ 嘘のログ**へ変わる。
   * 運用者は**存在しない鍵の設定漏れ**を疑い、しかもラッチが立つので本物の鍵欠落は
   * 同一インスタンスで二度と記録されない。画面の文言は正しいままなので**症状から辿れない**。
   */
  it('🔴 鍵以外の throw は 503 に化けない（catch の射程）', async () => {
    readAnswerToken.mockRejectedValue(new Error('boom'));
    await expect(call()).rejects.toThrow('boom');
  });

  /**
   * 🔴 **下界。** 「throw したら 503」だけなら**常に 503**の世界でも満たせる。
   * 鍵が在る環境の無効トークンは従来どおり 403 であることまで見る。
   */
  it('🔴 鍵が在る環境の無効トークンは従来どおり 403（503 に倒れない）', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
  });

  /**
   * 🔴 **応答だけでなく記録も配線されていること (#1123 AC3)。**
   * `secretUnavailableResponse()` は「503 を返す」と「設定不備を 1 度だけ記録する」を
   * 束ねている。**束ねたことを配線側で検査しないと、素の 503 へ差し替える変異が
   * 素通りする**（レビュー 1 周目の実測 —— 4 か所すべてを素の 503 にしても全テスト green）。
   */
  it('🔴 POST: 設定不備を env 名つきで 1 度だけ記録する', async () => {
    getAnswerSecret.mockImplementation(() => {
      throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      __resetSecretUnavailableLog();
      for (let i = 0; i < 3; i += 1) await call();
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain('CALL_ANSWER_SECRET');
      // 🔴 値は出さない（rules/pii-secret-minimization.md）。
      expect(logged).not.toMatch(/dev-insecure/);
    } finally {
      spy.mockRestore();
      __resetSecretUnavailableLog();
    }
  });
});
