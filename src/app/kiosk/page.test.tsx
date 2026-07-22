/**
 * `/kiosk` エントリのサーバ側配線テスト (issue #367)。
 *
 * `src/components/kiosk/KioskFlow.tsx` は無改変前提の別トラック占有コンポーネントのため実体は
 * mock する。ここで検証するのは「ページが `resolveDefaultScope` の既定スコープで営業状態を評価し、
 * その結果を `KioskFlow` の `operatingStatus` prop へそのまま渡す」配線だけ。
 */
import { describe, expect, it, vi } from 'vitest';

const resolveKioskStatusFor = vi.fn();
const { mockKioskFlow } = vi.hoisted(() => ({ mockKioskFlow: vi.fn(() => null) }));

vi.mock('@/components/kiosk/KioskFlow', () => ({
  KioskFlow: mockKioskFlow,
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('@/lib/operating-policy/store', () => ({
  resolveKioskStatusFor: (...a: unknown[]) => resolveKioskStatusFor(...a),
}));

import KioskHomePage from './page';

describe('KioskHomePage (#367 operatingStatus 配線)', () => {
  it('既定スコープ（tenant/site）で営業状態を評価し KioskFlow へ渡す', async () => {
    resolveKioskStatusFor.mockResolvedValue({ state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' });
    const element = await KioskHomePage();
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('internal', 'default-site');
    expect(element.type).toBe(mockKioskFlow);
    expect(element.props).toEqual({ operatingStatus: { state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' } });
  });

  it('ポリシー未設定（undefined）は KioskFlow へ undefined のまま渡す（fail-open）', async () => {
    resolveKioskStatusFor.mockResolvedValue(undefined);
    const element = await KioskHomePage();
    expect(element.props).toEqual({ operatingStatus: undefined });
  });
});
