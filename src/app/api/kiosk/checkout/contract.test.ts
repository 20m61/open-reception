/**
 * **ルートが返す封筒が、受付端末の述語を通ること** (#1004 増分 2、独立レビュー 3 周目 MAJOR-D)。
 *
 * ## なぜ純関数の契約テストでは足りなかったか
 *
 * 増分 2 は退館導線を「寛容」から「**形が違えば拒否**」へ変えた。そこで
 * `src/components/kiosk/checkout/parse.contract.test.ts` を書いたが、あれは
 * **封筒を手で書き写していた**（`{ method, summary }` / `{ stays }`）。型注釈はフィールドの
 * 型しか結ばないので、**ルート側が封筒のキーを変えても素通り**する ―― 実測で
 * `summary` → `stay`、`stays` → `present` のどちらの変異も **8221 テスト全部が緑のまま**
 * だった（レビューの実測 S1 / S2）。
 *
 * 「写しは必ずズレる」を書いておきながら、**契約テスト自身が写しだった**。
 *
 * ## ここが縛るもの
 *
 * ルートハンドラを**実際に呼び**、`await res.json()` をそのまま述語へ食わせる。
 * 封筒のキー名・`NextResponse.json` の `undefined` 落とし・ステータスまで実物で通る。
 * サーバが封筒を変えれば、ここが落ちる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asCheckoutResolveResult, asPresentStayList } from '@/components/kiosk/checkout/parse';

const requireKioskSession = vi.fn();
const resolveStayScope = vi.fn();
const listPresent = vi.fn();
const resolve = vi.fn();
const readCheckoutResolveInput = vi.fn();

vi.mock('@/lib/visit/request', () => ({
  requireKioskSession: (...a: unknown[]) => requireKioskSession(...a),
  readStayId: () => null,
  readCheckoutResolveInput: (...a: unknown[]) => readCheckoutResolveInput(...a),
  checkoutFailureResponse: () => new Response(null, { status: 400 }),
  checkoutSelfIdFailureResponse: () => new Response(null, { status: 400 }),
}));
vi.mock('@/lib/visit/store', () => ({
  resolveStayScope: (...a: unknown[]) => resolveStayScope(...a),
  getKioskStayService: () => ({ listPresent, checkOutById: vi.fn() }),
}));
vi.mock('@/lib/visit/checkout-credential', () => ({
  getCheckoutCredentialService: () => ({ resolve }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({ appendAuditLog: vi.fn() }));

import { GET } from './route';
import { POST as RESOLVE } from './resolve/route';

beforeEach(() => {
  vi.clearAllMocks();
  requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  resolveStayScope.mockResolvedValue({ tenantId: 'internal', siteId: 'default-site' });
});

describe('GET /api/kiosk/checkout の封筒契約 (#1004)', () => {
  it('在館一覧の応答が asPresentStayList を通る', async () => {
    listPresent.mockResolvedValue([
      {
        id: 's1',
        stayId: 's1',
        checkedInAt: '2026-01-01T09:00:00.000Z',
        targetLabel: '総務部',
        purpose: '打ち合わせ',
        status: 'present',
      },
      // 任意フィールドが無い在館者（`NextResponse.json` がキーごと落とす形）。
      { id: 's2', stayId: 's2', checkedInAt: '2026-01-01T10:00:00.000Z', status: 'present' },
    ]);

    const parsed = asPresentStayList(await (await GET()).json());

    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
  });

  it('在館者ゼロの応答も通る（受付直後の通常状態）', async () => {
    listPresent.mockResolvedValue([]);
    expect(asPresentStayList(await (await GET()).json())).toEqual([]);
  });
});

describe('POST /api/kiosk/checkout/resolve の封筒契約 (#1004)', () => {
  function request(): Request {
    return new Request('http://localhost/api/kiosk/checkout/resolve', {
      method: 'POST',
      body: JSON.stringify({ code: '1234', targetLabel: '総務部' }),
    });
  }

  it('解決成功の応答が asCheckoutResolveResult を通る', async () => {
    readCheckoutResolveInput.mockReturnValue({ code: '1234', targetLabel: '総務部' });
    resolve.mockReturnValue({
      ok: true,
      method: 'code',
      summary: { checkedInAt: '2026-01-01T09:00:00.000Z', targetLabel: '総務部', purpose: '打ち合わせ' },
    });

    const parsed = asCheckoutResolveResult(await (await RESOLVE(request())).json());

    expect(parsed).not.toBeNull();
    expect(parsed?.method).toBe('code');
    expect(parsed?.summary.checkedInAt).toBe('2026-01-01T09:00:00.000Z');
  });

  /**
   * `issue` 側が `?? ''` で埋めるので、ラベル・用件は**空文字で来ることがある**。
   * これを弾くと呼び出し先未設定の来訪者だけ退館できなくなる。
   */
  it('空文字のラベル・用件でも通る', async () => {
    readCheckoutResolveInput.mockReturnValue({ payload: 'tok' });
    resolve.mockReturnValue({
      ok: true,
      method: 'qr',
      summary: { checkedInAt: '2026-01-01T09:00:00.000Z', targetLabel: '', purpose: '' },
    });
    expect(asCheckoutResolveResult(await (await RESOLVE(request())).json())).not.toBeNull();
  });
});
