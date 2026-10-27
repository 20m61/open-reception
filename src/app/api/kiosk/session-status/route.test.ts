/**
 * `GET /api/kiosk/session-status` の `pinRequired` (#1172 AC3) —— 配線のテスト。
 *
 * 以前は保存レコードの `pinRequired` を検証せずに返していたので、欠落した記録では
 * **`pinRequired: undefined`**（JSON では鍵ごと消える）を返し、端末側は PIN 不要と読んでいた。
 * store を本物（memory backend）のまま通し、読めない記録で PIN 必須（`true`）を返すことを縛る。
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

beforeEach(async () => {
  await __resetSecurity();
  await __resetLogStore();
});

describe('GET /api/kiosk/session-status (#1172 AC3)', () => {
  it.each([
    ['欠落', undefined],
    ["文字列 'false'", 'false'],
    ['0', 0],
  ])('🔴 pinRequired が %s なら PIN 必須（true）を返す', async (_l, value) => {
    await putRaw({ pinRequired: value, pin: '4821', ipAllowlist: [], emergencyStop: false });
    expect(await (await GET()).json()).toEqual({ pinRequired: true, authorized: false });
  });

  it('下界: 読める false はそのまま false', async () => {
    await putRaw({ pinRequired: false, pin: '4821', ipAllowlist: [], emergencyStop: false });
    expect(await (await GET()).json()).toEqual({ pinRequired: false, authorized: false });
  });
});
