/**
 * `/api/kiosk/checkin/resolve` の契約 (#736 / #98)。
 *
 * 🔴 **このルートにもテストが 1 本も無かった**（`confirm` と同じ穴）。QR 受付の入口で、
 * 「どのテナントの予約を引けるか」と「来訪者へ何を返すか」を決めているのはここ。
 *
 * QR の状態（有効 / 期限切れ / 使用済み / 失効 / 不明）はすべてこのルートを通って
 * 端末の文言へ変換される。状態ごとの HTTP の割り当てがずれると、端末は
 * 「もう一度かざしてください」と「スタッフへ」を取り違える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolve = vi.fn();
/** 閲覧のみのルートが**書き込み側を呼んでいない**ことを見るための spy。 */
const confirm = vi.fn();
const markUsed = vi.fn();
const requireKioskSession = vi.fn();
const resolveCheckinScope = vi.fn();

vi.mock('@/lib/checkin/store', () => ({
  getCheckinService: () => ({ resolve, confirm, markUsed }),
  resolveCheckinScope: (...a: unknown[]) => resolveCheckinScope(...a),
}));
vi.mock('@/lib/checkin/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/checkin/request')>()),
  requireKioskSession: () => requireKioskSession(),
}));

import { POST } from './route';

/** QR に載る token。**応答へ echo されていないこと**を見るために目印を付ける。 */
const PAYLOAD = 'https://reception.test/kiosk/checkin?t=TEST-token-echo-canary';

const SUMMARY = {
  visitorName: 'TEST-来客',
  companyName: 'TEST-商事',
  targetType: 'staff' as const,
  targetId: 'staff-seed',
  visitAt: '2026-08-21T00:00:00.000Z',
};

function request(body: unknown = { payload: PAYLOAD }): Request {
  return new Request('https://reception.test/api/kiosk/checkin/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** JSON にならない body（端末の通信が途中で切れた等）。 */
function brokenRequest(): Request {
  return new Request('https://reception.test/api/kiosk/checkin/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireKioskSession.mockResolvedValue({ kioskId: 'TEST-kiosk' });
  resolveCheckinScope.mockResolvedValue({ tenantId: 'TEST-tenant', siteId: 'TEST-site' });
  resolve.mockResolvedValue({ ok: true, summary: SUMMARY });
});

describe('POST /api/kiosk/checkin/resolve', () => {
  it('確認に必要なサマリを返す', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: SUMMARY });
  });

  /**
   * 🔴 **token を応答へ返さない。** 端末は既に持っているので返す必要が無く、
   * 返すと画面・ログ・キャッシュへ広がる（`rules/pii-secret-minimization.md`）。
   */
  it('🔴 受け取った payload を応答へ echo しない', async () => {
    const body = await (await POST(request())).text();
    expect(body).not.toContain('TEST-token-echo-canary');
  });

  /**
   * 閲覧のみ。**ここで使用済みにしない**（確認画面で来訪者の操作を待つ）。
   * 使用済み化まで進むと、確認前に離脱した来訪者の QR が死ぬ。
   */
  it('🔴 使用済み化しない（読むだけ）', async () => {
    await POST(request());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(markUsed).not.toHaveBeenCalled();
  });
});

describe('どのテナントの予約を引けるか (#736)', () => {
  it('端末セッションが無ければ 403（予約に触らない）', async () => {
    requireKioskSession.mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **未登録の端末を既定テナントへ倒さない。** 倒すと、台帳に無い端末から
   * **他テナントの予約を引ける**。fail-closed が正しい。
   */
  it('🔴 台帳に無い端末は 403（予約に触らない）', async () => {
    resolveCheckinScope.mockResolvedValue(undefined);
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('🔴 台帳の scope をそのまま渡す（既定へ差し替えない）', async () => {
    resolveCheckinScope.mockResolvedValue({ tenantId: 'TEST-other', siteId: 'TEST-other-site' });
    await POST(request());
    expect(resolve).toHaveBeenCalledWith('TEST-other', 'TEST-other-site', PAYLOAD);
  });
});

describe('QR の状態ごとの応答 (#736)', () => {
  /**
   * 端末はこの `error` で文言を選ぶ。状態起因（409）と「そもそも無い」（404）と
   * 「読めない」（400）を混ぜると、来訪者は「もう一度かざす」と「スタッフへ」を取り違える。
   */
  const CASES = [
    { reason: 'expired', status: 409 },
    { reason: 'used', status: 409 },
    { reason: 'revoked', status: 409 },
    { reason: 'not_found', status: 404 },
    { reason: 'invalid', status: 400 },
  ] as const;

  for (const { reason, status } of CASES) {
    it(`${reason} は ${status} と理由を返す`, async () => {
      resolve.mockResolvedValue({ ok: false, reason });
      const res = await POST(request());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: reason });
    });
  }

  /**
   * 🔴 **失効の理由を取り違えない。** ここが全部 200 や全部 400 に潰れても
   * 「エラーは出る」ので画面上は動いて見える。状態ごとに**別の**コードであることを縛る。
   */
  it('🔴 状態ごとに区別できる（全部同じコードに潰さない）', async () => {
    const seen = new Set<number>();
    for (const { reason } of CASES) {
      resolve.mockResolvedValue({ ok: false, reason });
      seen.add((await POST(request())).status);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('壊れた入力・通信断 (#736)', () => {
  it('JSON でない body は 400（予約に触らない）', async () => {
    const res = await POST(brokenRequest());
    expect(res.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('payload が文字列でなければ 400', async () => {
    const res = await POST(request({ payload: 42 }));
    expect(res.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  /**
   * リポジトリ例外は 503。端末はこれを networkError として扱い、**通常受付へ倒せる**
   * （QR が使えないだけで受付そのものは終われる ── touch-only completion）。
   */
  it('バックエンド障害は 503（端末が通常受付へ倒せる）', async () => {
    resolve.mockRejectedValue(new Error('TEST-backend-detail'));
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'network' });
  });

  /** 🔴 例外の内容を来訪者側へ返さない（`app/kiosk/error.tsx` と同じ方針）。 */
  it('🔴 例外の内容を応答へ載せない', async () => {
    resolve.mockRejectedValue(new Error('TEST-backend-detail'));
    const body = await (await POST(request())).text();
    expect(body).not.toContain('TEST-backend-detail');
  });
});
