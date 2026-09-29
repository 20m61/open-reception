/**
 * `POST /api/kiosk/authorize` が**壊れたセキュリティ設定で閉じる**こと (#1172) —— 配線のテスト。
 *
 * `route.test.ts` は store をモックしているので、store が返す「読めない許可リスト（`null`）」を
 * route が `isIpAllowed` へそのまま渡しているか（`?? []` のように開く側へ埋め戻していないか）は
 * 見えない。ここでは **store を本物（memory backend）のまま**通し、保存レコードを直接置く。
 *
 * 各ケースは**同じ要求**を「読める記録」と「壊れた記録」に当て、前者が通る（200）ことを下界にする
 * —— 前者が通らない世界では、後者の 403 / 401 は何も言っていない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/security/attempt-store', () => ({
  reserveLayeredSafely: vi.fn(async () => ({ allowed: true, nextWindow: { startedAt: 0, failures: 0 } })),
  recordLayeredSuccess: vi.fn(async () => true),
}));
vi.mock('@/lib/security/attempt-report', () => ({
  reportAttemptBudgetExceeded: vi.fn(),
  reportAttemptStoreUnavailable: vi.fn(),
}));
vi.mock('@/lib/security/client-identity', () => ({
  assertIdentitySaltAvailable: vi.fn(),
  clientIdentity: vi.fn(async () => 'test-identity'),
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  KIOSK_SESSION_TTL_MS: 1000,
  issueKioskSession: vi.fn(async () => 'signed-kiosk-session'),
}));

import { POST } from './route';
import { __resetSecurity } from '@/lib/security/security-store';
import { __resetLogStore } from '@/lib/data-stores/reception-log-store';
import { getBackend } from '@/lib/data';

const LISTED = '203.0.113.7';
const PIN = '4821';

async function putRaw(record: Record<string, unknown>): Promise<void> {
  await getBackend().singleton('security', { default: () => ({}) }).put(record);
}

function authorize(ip: string, pin = PIN) {
  return POST(
    new Request('http://localhost/api/kiosk/authorize', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: JSON.stringify({ pin, kioskId: 'kiosk-dev' }),
    }),
  );
}

beforeEach(async () => {
  await __resetSecurity();
  await __resetLogStore();
});

describe('POST /api/kiosk/authorize は壊れたセキュリティ設定で閉じる (#1172)', () => {
  /** 🔴 AC1: 以前は配列でない許可リストが `[]`（全許可）に化け、どの IP からも通っていた。 */
  it.each([
    ['文字列', LISTED],
    ['オブジェクト', { a: 1 }],
    ['null', null],
    ['欠落', undefined],
  ])('🔴 許可リストが %s なら、以前は通っていた IP でも 403', async (_l, value) => {
    // 下界: 正しい形の空の許可リスト（制限なし）なら、同じ要求が通る。
    await putRaw({ pinRequired: true, pin: PIN, ipAllowlist: [], emergencyStop: false });
    expect((await authorize('198.51.100.1')).status).toBe(200);

    await putRaw({ pinRequired: true, pin: PIN, ipAllowlist: value, emergencyStop: false });
    for (const ip of ['198.51.100.1', LISTED]) {
      const res = await authorize(ip);
      expect(res.status, ip).toBe(403);
      expect(await res.json()).toMatchObject({ message: 'ip not allowed' });
    }
  });

  it('下界: 正しい形の許可リストでは、載っている IP だけが通る', async () => {
    await putRaw({ pinRequired: true, pin: PIN, ipAllowlist: [LISTED], emergencyStop: false });
    expect((await authorize(LISTED)).status).toBe(200);
    expect((await authorize('198.51.100.1')).status).toBe(403);
  });

  /**
   * 🔴 AC3: `pinRequired` が読めない記録では、正しい PIN でもセッションを出さない。
   * 以前（欠落 → falsy）は route の 403 で閉じていた。「PIN 必須」と読んで照合を通すと、
   * `pinRequired: false` のサイトで閉じていた自己許可が開く（公開既定の `0000` なら誰でも）。
   */
  it.each([
    ['欠落', undefined],
    ["文字列 'true'", 'true'],
    ["文字列 'false'", 'false'],
  ])('🔴 PIN 必須が %s なら、正しい PIN でもセッションを出さない', async (_l, value) => {
    await putRaw({ pinRequired: true, pin: PIN, ipAllowlist: [], emergencyStop: false });
    expect((await authorize(LISTED)).status).toBe(200);

    await putRaw({ pinRequired: value, pin: PIN, ipAllowlist: [], emergencyStop: false });
    const res = await authorize(LISTED);
    expect(res.status).not.toBe(200);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('kiosk_session');
  });
});
