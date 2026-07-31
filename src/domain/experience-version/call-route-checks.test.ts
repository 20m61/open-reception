/**
 * 取次到達性の公開前検証の単体テスト (issue #420)。
 *
 * 固定するのは severity の線引き:
 *   - **実際の呼び出しが使う** `RoutingPolicy` の契約破れ → error（届かない状態で公開させない）
 *   - 有効ポリシー 0 件 → warning（既定の単一呼び出しへフォールバックし受付は完遂する）
 *   - **現 runtime が参照しない**旧 `callRouteId` の参照切れ → warning
 */
import { describe, expect, it } from 'vitest';
import type { RoutingPolicy } from '@/domain/routing/policy';
import { checkCallRoutes } from './call-route-checks';

function policy(over: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    id: 'p1',
    tenantId: 'internal',
    siteId: 'default-site',
    name: 'TEST-ポリシー',
    enabled: true,
    steps: [{ id: 's1', endpointId: 'e1', action: 'live_bridge', timeoutSeconds: 20, nextOn: {} }],
    ...over,
  };
}

const endpoints = new Set(['e1']);

describe('checkCallRoutes', () => {
  it('健全なポリシーでは指摘しない', () => {
    expect(checkCallRoutes({ policies: [policy()], endpointIds: endpoints })).toEqual([]);
  });

  it('存在しない呼び出し先を指す手順は error（呼び出しても届かない）', () => {
    const findings = checkCallRoutes({
      policies: [policy({
        steps: [{ id: 's1', endpointId: 'missing', action: 'live_bridge', timeoutSeconds: 20, nextOn: {} }],
      })],
      endpointIds: endpoints,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'call_route', severity: 'error' });
    expect(findings[0]?.message).toContain('missing');
  });

  it('手順が空のポリシーは error', () => {
    const findings = checkCallRoutes({
      policies: [policy({ steps: [] })],
      endpointIds: endpoints,
    });
    expect(findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('有効な取次ポリシーが 0 件なら warning（既定の単一呼び出しで受付は完遂する）', () => {
    expect(checkCallRoutes({ policies: [], endpointIds: endpoints })).toEqual([
      {
        check: 'call_route',
        severity: 'warning',
        message: '有効な取次ポリシーがありません（既定の単一呼び出しで動作します）',
      },
    ]);
  });

  it('指摘メッセージに宛先（電話番号・URI）を載せない', () => {
    const findings = checkCallRoutes({
      policies: [policy({
        steps: [{ id: 's1', endpointId: 'missing', action: 'live_bridge', timeoutSeconds: 20, nextOn: {} }],
      })],
      endpointIds: endpoints,
    });
    // 載るのは ID だけ。宛先は endpoint 側に閉じている（EndpointRef の設計と同じ扱い）。
    expect(findings[0]?.message).not.toMatch(/\+\d|sip:|tel:/);
  });
});
