/**
 * `/kiosk` エントリのサーバ側配線テスト (issue #367)。
 *
 * サーバ側で評価した営業状態を、薄いクライアントラッパ `OperatingStatusRefresher` の
 * `initialStatus` へ渡す配線だけを検証する。ラッパ（および別トラック占有の
 * `src/components/kiosk/KioskFlow.tsx`）は実体を mock する。定期再取得の挙動自体は
 * `src/lib/kiosk/operating-status-poll.test.ts` で検証する。
 */
import { describe, expect, it, vi } from 'vitest';

const resolveKioskStatusFor = vi.fn();
const { mockRefresher } = vi.hoisted(() => ({ mockRefresher: vi.fn(() => null) }));

vi.mock('./OperatingStatusRefresher', () => ({
  OperatingStatusRefresher: mockRefresher,
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('@/lib/operating-policy/store', () => ({
  resolveKioskStatusFor: (...a: unknown[]) => resolveKioskStatusFor(...a),
}));

import KioskHomePage from './page';

describe('KioskHomePage (#367 operatingStatus 配線)', () => {
  it('既定スコープ（tenant/site）で営業状態を評価し initialStatus として渡す', async () => {
    resolveKioskStatusFor.mockResolvedValue({ state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' });
    const element = await KioskHomePage();
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('internal', 'default-site');
    expect(element.type).toBe(mockRefresher);
    expect(element.props).toEqual({
      initialStatus: { state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' },
    });
  });

  it('ポリシー未設定（undefined）は initialStatus=undefined のまま渡す（fail-open）', async () => {
    resolveKioskStatusFor.mockResolvedValue(undefined);
    const element = await KioskHomePage();
    expect(element.props).toEqual({ initialStatus: undefined });
  });
});
