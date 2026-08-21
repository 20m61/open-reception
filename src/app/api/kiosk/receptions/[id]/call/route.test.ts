/**
 * kiosk 取次ルート（`/api/kiosk/receptions/:id/call`）の実行時配線テスト (issue #374, #367)。
 *
 * 検証:
 *   - kiosk セッション必須（無ければ 403、取次を実行しない）。
 *   - 保存済みルートがあれば Orchestrator の段階実行結果で状態確定し、応答に stages[] を付す。
 *   - ルート未設定（fail-open）は従来どおり単発 Mock（startCall 既定 adapter）へ委ね、stages を付さない。
 *   - 取次実行が失敗しても従来応答へ倒す（fail-open）。
 *   - 営業時間外ガード (#367): closed 判定は 409（取次を実行しない）、open/判定不能（fail-open）は従来どおり。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const denyWithoutKioskSession = vi.fn();
const startCall = vi.fn();
const executeRoutedCall = vi.fn();
const routedCallAdapter = vi.fn();
const evaluateCallGuard = vi.fn();

vi.mock('@/lib/kiosk/session-guard', () => ({
  denyWithoutKioskSession: (...a: unknown[]) => denyWithoutKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  startCall: (...a: unknown[]) => startCall(...a),
}));
vi.mock('@/lib/routing/call-execution', () => ({
  executeRoutedCall: (...a: unknown[]) => executeRoutedCall(...a),
  routedCallAdapter: (...a: unknown[]) => routedCallAdapter(...a),
  // 実物と同じ値でなければ、ルートの分岐がテストの中でだけ当たらなくなる。
  REAL_DIALING_UNAVAILABLE: 'real_dialing_unavailable',
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('@/lib/operating-policy/call-guard', () => ({
  evaluateCallGuard: (...a: unknown[]) => evaluateCallGuard(...a),
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
  evaluateCallGuard.mockResolvedValue({ allowed: true });
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

  /**
   * 🔴 **実発信を止めているときに「呼び出したふり」をしない (N0)。**
   *
   * 以前はキルスイッチが `resolveVoiceInitiator` を null にするだけで、`executeRoutedCall` は
   * mock へ倒れた。mock は bridge 系を**無条件で `'answered'`** にするので、来訪者には
   * 「担当者が応答しました」と出て `completed` に到達していた ——
   * **誰も呼ばれていないのに全員が受付完了する。**運用者からは「全員入館できている」
   * ように見えるため、全断に気づくのが遅れる。
   */
  /**
   * 🔴 **実発信のつもりのテナントで「呼び出したふり」をしない (#736)。**
   *
   * N0 が塞いだのはキルスイッチだけで、**資格情報の不備は素通り**だった。
   * `resolveProviderForTenant` は secret 欠如も設定不備もすべて `mock` へ畳むので、
   * vonage + enabled と設定したテナントでも mock provider が bridge 系を無条件で
   * `'answered'` にし、来訪者には「担当者が応答しました」と出て受付が `completed` に
   * 到達していた —— **誰も呼ばれていないのに全員が受付完了する**。
   *
   * 運用者からは「全員入館できている」ように見えるため、設定不備に気づく手掛かりが
   * 一つも無い。8/30 Gate で最も起きやすい形（資格情報を入れ忘れて公開する）。
   */
  describe('実発信のつもりで撃てなかったとき (#736)', () => {
    it('🔴 誰も呼ばず、取り次げないことを返す', async () => {
      executeRoutedCall.mockResolvedValue('real_dialing_unavailable');
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unrouted' });
      expect(startCall).not.toHaveBeenCalled();
    });

    it('🔴 mock へ倒さない（受付を connected にしない）', async () => {
      executeRoutedCall.mockResolvedValue('real_dialing_unavailable');
      await call();
      expect(routedCallAdapter).not.toHaveBeenCalled();
    });

    /** 設定が mock（dev / デモ / 未設定）のテナントは従来どおり完走する。 */
    it('ルート未設定（fail-open）は従来どおり単発 mock へ倒す', async () => {
      executeRoutedCall.mockResolvedValue(null);
      startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });
      const res = await call();
      expect(res.status).toBe(200);
      expect(startCall).toHaveBeenCalled();
    });
  });

  describe('VOICE_DIALING_DISABLED (N0)', () => {
    afterEach(() => {
      delete process.env.VOICE_DIALING_DISABLED;
    });

    it('🔴 止めているときは誰も呼ばず、取り次げないことを返す', async () => {
      process.env.VOICE_DIALING_DISABLED = '1';
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unrouted' });
      // 🔴 **ここが本体。** 呼び出し経路に一切入らないこと。
      expect(executeRoutedCall).not.toHaveBeenCalled();
      expect(startCall).not.toHaveBeenCalled();
    });

    it('止めていなければ従来どおり呼び出す', async () => {
      startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });
      executeRoutedCall.mockResolvedValue(null);
      const res = await call();
      expect(res.status).toBe(200);
      expect(startCall).toHaveBeenCalled();
    });
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
    expect(startCall).toHaveBeenCalledWith('rec-1', expect.anything(), 'internal');
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
    expect(startCall).toHaveBeenCalledWith('rec-1', undefined, 'internal');
    expect(routedCallAdapter).not.toHaveBeenCalled();
  });

  it('取次実行が例外でも fail-open（従来応答）', async () => {
    executeRoutedCall.mockRejectedValue(new Error('boom'));
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('stages');
    expect(startCall).toHaveBeenCalledWith('rec-1', undefined, 'internal');
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

describe('POST /api/kiosk/receptions/:id/call — 営業時間外ガード (#367)', () => {
  it('closed 判定は 409（out_of_hours）を返し、取次を実行しない', async () => {
    evaluateCallGuard.mockResolvedValue({ allowed: false, reason: 'out_of_hours', reopenAt: '2026-07-23T00:00:00.000Z' });
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'out_of_hours', reason: 'out_of_hours', reopenAt: '2026-07-23T00:00:00.000Z' });
    expect(executeRoutedCall).not.toHaveBeenCalled();
    expect(startCall).not.toHaveBeenCalled();
  });

  it('reopenAt 無しの closed 判定でも 409（reopenAt フィールドは省略）', async () => {
    evaluateCallGuard.mockResolvedValue({ allowed: false, reason: 'out_of_hours' });
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'out_of_hours', reason: 'out_of_hours' });
  });

  it('open（allowed:true）は従来どおり取次を実行する', async () => {
    evaluateCallGuard.mockResolvedValue({ allowed: true });
    executeRoutedCall.mockResolvedValue(null);
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(startCall).toHaveBeenCalled();
  });

  it('kiosk セッションが無ければ営業時間ガードより先に 403 で止まる（ガード未評価）', async () => {
    denyWithoutKioskSession.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const res = await call();
    expect(res.status).toBe(403);
    expect(evaluateCallGuard).not.toHaveBeenCalled();
  });
});

/**
 * 実発信の配線 (#4 Inc D-2 項目 2)。
 *
 * 🔴 `webhookBaseUrl` を渡し忘れても**すべてのテストが緑のまま通る** — `executeRoutedCall` は
 * 分からなければ mock へ倒すので、症状は「実発信が永久に起きない」という**沈黙**だけになる。
 * このリポジトリが繰り返し踏んできた「緑の要約が未配線を隠す」形なので、引数そのものを固定する。
 */
describe('POST /api/kiosk/receptions/:id/call — 実発信の配線 (#4 Inc D-2)', () => {
  it('🔴 executeRoutedCall へ webhookBaseUrl を渡す（渡さないと実発信が起きない）', async () => {
    executeRoutedCall.mockResolvedValue(null);
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    await call();

    expect(executeRoutedCall).toHaveBeenCalledWith(
      { tenantId: 'internal', siteId: 'default-site' },
      'rec-1',
      expect.objectContaining({ webhookBaseUrl: expect.stringMatching(/^https?:\/\//) }),
    );
  });

  it('CloudFront 経由なら x-forwarded-host を基底にする（Function URL を渡さない）', async () => {
    executeRoutedCall.mockResolvedValue(null);
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected' } });

    await POST(
      new Request('http://some-fn-url.lambda-url.ap-northeast-1.on.aws/api/kiosk/receptions/rec-1/call', {
        method: 'POST',
        headers: { 'x-forwarded-host': 'kiosk.example.test', 'x-forwarded-proto': 'https' },
      }),
      { params: Promise.resolve({ id: 'rec-1' }) },
    );

    const options = executeRoutedCall.mock.calls[0]?.[2] as { webhookBaseUrl: string };
    // Function URL のホストを渡すと Vonage の webhook が origin-verify で 403 になる（#612 同型）。
    expect(options.webhookBaseUrl).not.toContain('lambda-url');
  });

  it("実発信（calling）でも stages を返し、結果を同期で確定しない", async () => {
    executeRoutedCall.mockResolvedValue({
      status: 'calling',
      stages: [
        { key: 'personal', status: 'active' },
        { key: 'department', status: 'pending' },
      ],
      providerCallId: 'TEST-provider-call-id',
    });
    startCall.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'calling' } });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('calling');
    expect(body.stages).toEqual([
      { key: 'personal', status: 'active' },
      { key: 'department', status: 'pending' },
    ]);
    // 応答に provider 通話 ID を出さない（相関キーは来訪者端末へ渡さない）。
    expect(JSON.stringify(body)).not.toContain('TEST-provider-call-id');
  });
});
