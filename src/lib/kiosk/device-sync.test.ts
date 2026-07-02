/**
 * kiosk → Device 逆方向同期ヘルパのテスト (issue #284 inc1)。
 *
 * /admin/kiosks の作成・setEnabled 時に Device レジストリへ即時写像する配線を検証する。
 * 同期は best-effort（Device 側の失敗で kiosk 管理操作を壊さない。read 時 union が表示を
 * 担保し、次の heartbeat の adoptKiosk が収束させる）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const syncKioskState = vi.fn();
const SCOPE = { tenantId: 'internal', siteId: 'default-site' };

vi.mock('@/lib/tenant/store', () => ({
  getDeviceService: () => ({ syncKioskState: (...a: unknown[]) => syncKioskState(...a) }),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => SCOPE,
}));

import { syncKioskToDevice } from './device-sync';

beforeEach(() => {
  vi.clearAllMocks();
  syncKioskState.mockResolvedValue({ created: true, updated: false });
});

describe('syncKioskToDevice (#284 inc1)', () => {
  it('kiosk を既定スコープの Device へ写像する', async () => {
    await syncKioskToDevice({
      id: 'kiosk-1',
      displayName: '受付端末1',
      location: '1F',
      enabled: true,
    });
    expect(syncKioskState).toHaveBeenCalledWith(
      { id: 'kiosk-1', displayName: '受付端末1', location: '1F', enabled: true },
      SCOPE,
    );
  });

  it('location 未設定の kiosk はフィールドを渡さない', async () => {
    await syncKioskToDevice({ id: 'kiosk-1', displayName: '受付端末1', enabled: false });
    expect(syncKioskState).toHaveBeenCalledWith(
      { id: 'kiosk-1', displayName: '受付端末1', enabled: false },
      SCOPE,
    );
  });

  it('Device 同期の失敗は握りつぶす（kiosk 管理操作を壊さない best-effort）', async () => {
    syncKioskState.mockRejectedValue(new Error('backend down'));
    await expect(
      syncKioskToDevice({ id: 'kiosk-1', displayName: '受付端末1', enabled: true }),
    ).resolves.toBeUndefined();
  });
});
