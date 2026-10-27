/**
 * 担当者応答アクションルートの単体テスト (issue #99 inc1/2)。
 * 認可（応答トークン・受付一致）・種別バリデーション・状態（calling/connected 必須）・
 * サイト設定の尊重（無効種別 409・文言上書きの伝播）・有効種別取得 GET を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetSecretUnavailableLog } from '@/lib/auth/secret-unavailable';

const recordStaffResponse = vi.fn();
const getReception = vi.fn();
const readAnswerToken = vi.fn();
const resolveOverrides = vi.fn();
const resolveCheckinScope = vi.fn();

vi.mock('@/lib/data-stores/reception-store', () => ({
  recordStaffResponse: (...a: unknown[]) => recordStaffResponse(...a),
  getReception: (...a: unknown[]) => getReception(...a),
}));
const getAnswerSecret = vi.fn(() => 'TEST-answer-secret');
vi.mock('@/lib/call/answer-token', () => ({
  readAnswerToken: (...a: unknown[]) => readAnswerToken(...a),
  getAnswerSecret: () => getAnswerSecret(),
}));
vi.mock('@/lib/checkin/store', () => ({
  resolveCheckinScope: (...a: unknown[]) => resolveCheckinScope(...a),
}));
vi.mock('@/lib/reception/staff-response-config/store', () => ({
  getStaffResponseConfigService: () => ({ resolveOverrides: (...a: unknown[]) => resolveOverrides(...a) }),
}));

import { GET, POST } from './route';

function post(opts?: { id?: string; token?: string; action?: unknown }) {
  const id = opts?.id ?? 'rec-1';
  return POST(
    new Request('http://localhost/api/staff/calls/rec-1/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: opts?.token ?? 'tok', action: opts?.action ?? 'coming' }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(opts?: { id?: string; token?: string }) {
  const id = opts?.id ?? 'rec-1';
  const token = opts?.token ?? 'tok';
  return GET(new Request(`http://localhost/api/staff/calls/rec-1/respond?token=${token}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` は呼び出し履歴だけを消し、**実装は残る**。
  // 鍵を throw させるテストの実装が次のテストへ漏れないよう、毎回立て直す。
  getAnswerSecret.mockImplementation(() => 'TEST-answer-secret');
  readAnswerToken.mockResolvedValue({ receptionId: 'rec-1' });
  getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1' } });
  resolveCheckinScope.mockReturnValue({ tenantId: 'dev-tenant', siteId: 'dev-site' });
  resolveOverrides.mockResolvedValue({});
  recordStaffResponse.mockResolvedValue({
    ok: true,
    value: {
      action: 'coming',
      kioskStatus: 'acknowledged',
      visitorMessage: '担当者がまもなくお越しになります。少々お待ちください。',
      severity: 'success',
      offersFallback: false,
      respondedAt: '2026-06-20T00:00:00.000Z',
    },
  });
});

describe('POST /api/staff/calls/:id/respond', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await post()).status).toBe(403);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('403 when the token is for a different reception', async () => {
    readAnswerToken.mockResolvedValue({ receptionId: 'other' });
    expect((await post()).status).toBe(403);
  });

  it('400 when the action is unknown', async () => {
    const res = await post({ action: 'nope' });
    expect(res.status).toBe(400);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    expect((await post()).status).toBe(404);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('409 when the reception is not in a callable state', async () => {
    recordStaffResponse.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'no' } });
    expect((await post()).status).toBe(409);
  });

  it('409 when the action is disabled for the site', async () => {
    resolveOverrides.mockResolvedValue({ coming: { enabled: false } });
    const res = await post({ action: 'coming' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('action_disabled');
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('passes the configured visitor message override to recordStaffResponse', async () => {
    resolveOverrides.mockResolvedValue({ coming: { messageOverride: 'すぐ参ります' } });
    await post({ action: 'coming' });
    expect(recordStaffResponse).toHaveBeenCalledWith('rec-1', 'coming', {
      messageOverride: 'すぐ参ります',
    });
  });

  it('falls back to the default message when no override is configured', async () => {
    await post({ action: 'coming' });
    expect(recordStaffResponse).toHaveBeenCalledWith('rec-1', 'coming', {
      messageOverride: '担当者がまもなくお越しになります。少々お待ちください。',
    });
  });

  it('records the response and returns the visitor-facing result (no PII)', async () => {
    const res = await post({ action: 'coming' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe('coming');
    expect(data.kioskStatus).toBe('acknowledged');
    expect(Object.keys(data).sort()).toEqual([
      'action',
      'kioskStatus',
      'offersFallback',
      'respondedAt',
      'severity',
      'visitorMessage',
    ]);
  });
});

describe('GET /api/staff/calls/:id/respond', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
  });

  it('returns the enabled flags from site config (no visitor message / PII)', async () => {
    resolveOverrides.mockResolvedValue({ decline: { enabled: false } });
    const res = await get();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { actions: Array<Record<string, unknown>> };
    const decline = data.actions.find((a) => a.action === 'decline');
    expect(decline?.enabled).toBe(false);
    const coming = data.actions.find((a) => a.action === 'coming');
    expect(coming?.enabled).toBe(true);
    // 来訪者文言を含まない（種別メタのみ）。
    expect(Object.keys(coming ?? {}).sort()).toEqual([
      'action',
      'enabled',
      'requiresConfirmation',
      'severity',
      'staffLabel',
    ]);
  });
});

/**
 * 🔴 **鍵未設定デプロイで uncaught 例外を出さない (#1123)。**
 *
 * `getAnswerSecret()` は #1021 で failClosed（`KIOSK_ENROLLMENT_SECRET` は元から）なので、
 * 鍵を入れ忘れたデプロイでは `readAnswerToken` が throw する。route が受けていないと
 * Next の既定 500 になり、(a) **未認証の誰からでも**スタックトレースを 1 リクエストにつき
 * 1 本生ませられ、(b) 正常時（403）との差が「この環境は鍵を持っていない」の
 * オラクルになる。
 *
 * 写像先を 503 にするのは `src/app/api/kiosk/voice-transport/token/route.ts` の先例に
 * 揃えるため。🔴 **403 との差は残る＝オラクルは閉じていない。** その判断は #1127。
 */
describe('鍵未設定デプロイ (#1123)', () => {

  it('🔴 POST: 鍵の解決が throw しても uncaught にせず 503 を返す', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    expect((await post()).status).toBe(503);
  });

  it('🔴 POST: 本文に env 名・鍵名を出さない（未認証で到達できる）', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const body = await (await post()).json();
    expect(JSON.stringify(body)).not.toMatch(/SECRET|dev-insecure/);
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
  it('🔴 POST: 鍵以外の throw は 503 に化けない（catch の射程）', async () => {
    readAnswerToken.mockRejectedValue(new Error('boom'));
    await expect(post()).rejects.toThrow('boom');
  });

  it('🔴 GET: 鍵以外の throw は 503 に化けない（catch の射程）', async () => {
    readAnswerToken.mockRejectedValue(new Error('boom'));
    await expect(get()).rejects.toThrow('boom');
  });

  /** 🔴 下界。「常に 503」では満たせないよう、鍵が在る環境の無効トークンを併せて縛る。 */
  it('🔴 POST: 鍵が在る環境の無効トークンは従来どおり 403（503 に倒れない）', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await post()).status).toBe(403);
  });

  it('🔴 GET: 鍵の解決が throw しても uncaught にせず 503 を返す', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    expect((await get()).status).toBe(503);
  });

  it('🔴 GET: 本文に env 名・鍵名を出さない（未認証で到達できる）', async () => {
    getAnswerSecret.mockImplementation(() => {
    throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const body = await (await get()).json();
    expect(JSON.stringify(body)).not.toMatch(/SECRET|dev-insecure/);
  });

  /** 🔴 下界。「常に 503」では満たせないよう、鍵が在る環境の無効トークンを併せて縛る。 */
  it('🔴 GET: 鍵が在る環境の無効トークンは従来どおり 403（503 に倒れない）', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
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
      for (let i = 0; i < 3; i += 1) await post();
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

  /**
   * 🔴 **応答だけでなく記録も配線されていること (#1123 AC3)。**
   * `secretUnavailableResponse()` は「503 を返す」と「設定不備を 1 度だけ記録する」を
   * 束ねている。**束ねたことを配線側で検査しないと、素の 503 へ差し替える変異が
   * 素通りする**（レビュー 1 周目の実測 —— 4 か所すべてを素の 503 にしても全テスト green）。
   */
  it('🔴 GET: 設定不備を env 名つきで 1 度だけ記録する', async () => {
    getAnswerSecret.mockImplementation(() => {
      throw new Error('CALL_ANSWER_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      __resetSecretUnavailableLog();
      for (let i = 0; i < 3; i += 1) await get();
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
