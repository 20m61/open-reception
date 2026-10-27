/**
 * `GET /api/kiosk/heartbeat` が**壊れたセキュリティ設定で閉じる**こと (#1172 AC2 / AC3) —— 配線のテスト。
 *
 * `route.test.ts` は store と `effectiveKioskActive` をモックしているので、store の正規化が
 * heartbeat の応答まで届いているかは見えない。ここでは store を本物（memory backend）のまま通す。
 * 身元の無い要求（セッション無し・kioskId 無し）は台帳を引かずに active=true 側から始まるので、
 * 応答の `active` は緊急停止だけで決まる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: vi.fn(async () => null),
}));

import { GET } from './route';
import { __resetSecurity } from '@/lib/security/security-store';
import { __resetLogStore } from '@/lib/data-stores/reception-log-store';
import { getBackend } from '@/lib/data';

async function putRaw(record: Record<string, unknown>): Promise<void> {
  await getBackend().singleton('security', { default: () => ({}) }).put(record);
}

async function heartbeat(): Promise<{ active: unknown; pinRequired: unknown }> {
  return (await (await GET(new Request('http://localhost/api/kiosk/heartbeat'))).json()) as {
    active: unknown;
    pinRequired: unknown;
  };
}

beforeEach(async () => {
  await __resetSecurity();
  await __resetLogStore();
});

describe('GET /api/kiosk/heartbeat は壊れたセキュリティ設定で閉じる (#1172)', () => {
  /** 🔴 AC2: 以前は欠落した緊急停止が falsy で「稼働」になっていた（押したはずの停止が消える）。 */
  it.each([
    ['欠落', undefined],
    ["文字列 'false'", 'false'],
    ['0', 0],
  ])('🔴 emergencyStop が %s なら停止（active=false）', async (_l, value) => {
    await putRaw({ pinRequired: false, pin: '4821', ipAllowlist: [], emergencyStop: false });
    expect((await heartbeat()).active).toBe(true);
    await putRaw({ pinRequired: false, pin: '4821', ipAllowlist: [], emergencyStop: value });
    expect((await heartbeat()).active).toBe(false);
  });

  /** 🔴 AC3: `pinRequired: undefined` を返さない（JSON で鍵ごと消えて端末が PIN 不要と読む）。 */
  it.each([
    ['欠落', undefined],
    ["文字列 'false'", 'false'],
  ])('🔴 pinRequired が %s なら PIN 必須（true）を返す', async (_l, value) => {
    await putRaw({ pinRequired: value, pin: '4821', ipAllowlist: [], emergencyStop: false });
    expect((await heartbeat()).pinRequired).toBe(true);
  });

  it('下界: 読める記録はそのまま', async () => {
    await putRaw({ pinRequired: false, pin: '4821', ipAllowlist: [], emergencyStop: false });
    expect(await heartbeat()).toMatchObject({ active: true, pinRequired: false });
  });
});
