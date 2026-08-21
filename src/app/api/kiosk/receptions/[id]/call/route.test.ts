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
const intendsRealDialing = vi.fn();

vi.mock('@/lib/kiosk/session-guard', () => ({
  denyWithoutKioskSession: (...a: unknown[]) => denyWithoutKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  startCall: (...a: unknown[]) => startCall(...a),
}));
// 🔴 **sentinel をここで再定義しない。** リテラルを二重に書くと、ルートとスタブが
// どちらもテスト内の値を見るため、実定数が `null` や `''` になる変異を**全テスト green の
// まま通す**（`null` になれば fail-open のテナント全部が 503 になる重大回帰）。
vi.mock('@/lib/routing/call-execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/routing/call-execution')>()),
  executeRoutedCall: (...a: unknown[]) => executeRoutedCall(...a),
  routedCallAdapter: (...a: unknown[]) => routedCallAdapter(...a),
}));
vi.mock('@/lib/platform/provider-resolution', () => ({
  intendsRealDialing: (...a: unknown[]) => intendsRealDialing(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('@/lib/operating-policy/call-guard', () => ({
  evaluateCallGuard: (...a: unknown[]) => evaluateCallGuard(...a),
}));

import { KIOSK_DIAL_LOG_MARKERS } from '@/lib/routing/dial-log-markers';
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
  // 既定は「実発信の意図なし」＝ dev / デモ / 未設定テナント（全 seed がこれ）。
  intendsRealDialing.mockResolvedValue(false);
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

    /**
     * 🔴 **経路 B: 資格情報は正常だが有効なルートが 1 つも無い。**
     * `runVoiceRoutedCall` が `null` を返し、ルートの fail-open が単発 mock adapter へ倒す。
     * `MockCallAdapter` は**部署呼び出しを無条件で `connected`** にするので、
     * 「資格情報は入れたがルートをまだ作っていない」という 8/30 で最も起きやすい形で
     * 同じ嘘が出る。`null` は fail-open と区別が付かないので**意図側**で倒す。
     */
    it('🔴 意図があるのにルート未設定なら mock へ倒さない（経路 B）', async () => {
      intendsRealDialing.mockResolvedValue(true);
      executeRoutedCall.mockResolvedValue(null);
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unrouted' });
      expect(startCall).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **経路 C: 取次の読み取りが throw。** ルートの `.catch` が `null` へ倒すので、
     * 意図の判定を `.catch` の**内側**に置くとガードごと握り潰される。
     */
    it('🔴 意図があるのに取次実行が throw したら mock へ倒さない（経路 C）', async () => {
      intendsRealDialing.mockResolvedValue(true);
      executeRoutedCall.mockRejectedValue(new Error('TEST-store-down'));
      const res = await call();
      expect(res.status).toBe(503);
      expect(startCall).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **意図の読み取り自体が失敗したら、意図ありへ倒す（fail-closed）。**
     * 誰も呼ばずに「呼び出しました」と言うより、取り次げないと言って有人支援へ倒すほうが
     * 回復できる。（現状 in-memory Map なので throw しないが、Inc2 の永続化で真になる。）
     */
    it('🔴 意図の読み取りが失敗したら嘘へ倒さない', async () => {
      intendsRealDialing.mockRejectedValue(new Error('TEST-config-store-down'));
      executeRoutedCall.mockResolvedValue(null);
      const res = await call();
      expect(res.status).toBe(503);
      expect(startCall).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **アラームが探す文言を実際に出す (#764)。**
     *
     * この経路は `startCall` に到達しないので受付履歴にもメトリクスにも残らず、
     * 503 は Lambda としては成功した呼び出しなので Errors にも出ない。
     * **ログ以外に手掛かりが無い**ので、文言が消えるとアラームは黙って鳴らなくなる。
     * CDK 側（`infra/test/web-monitoring-stack.test.ts`）が同じ定数でフィルタを縛る。
     */
    it('🔴 アラームが探すマーカーをログへ出す', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      intendsRealDialing.mockResolvedValue(true);
      executeRoutedCall.mockResolvedValue(null);
      await call();
      const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
      spy.mockRestore();
      expect(logged).toContain(KIOSK_DIAL_LOG_MARKERS.realDialingUnavailable);
    });

    /** 🔴 ログに secret や来訪者情報を載せない（テナント ID は PII ではない）。 */
    it('🔴 ログに例外の内容を載せない', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      intendsRealDialing.mockResolvedValue(true);
      executeRoutedCall.mockRejectedValue(new Error('TEST-store-detail'));
      await call();
      const logged = spy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
      spy.mockRestore();
      expect(logged).not.toContain('TEST-store-detail');
    });

    it('🔴 応答に例外の内容やテナントの secret を載せない', async () => {
      intendsRealDialing.mockResolvedValue(true);
      executeRoutedCall.mockRejectedValue(new Error('TEST-store-down'));
      const body = await (await call()).text();
      expect(body).not.toContain('TEST-store-down');
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
