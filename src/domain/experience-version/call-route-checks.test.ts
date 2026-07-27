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
import { checkCallRoutes, flowRouteIdsOf } from './call-route-checks';

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

  it('旧 callRouteId の参照切れは warning（現 runtime は参照しない）', () => {
    const findings = checkCallRoutes({
      policies: [policy()],
      endpointIds: endpoints,
      flowRouteIds: ['route-gone'],
      knownCallRouteIds: new Set(['route-1']),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'call_route', severity: 'warning' });
    expect(findings[0]?.message).toContain('route-gone');
  });

  it('旧 callRouteId が実在すれば指摘しない。同じ ID の重複も 1 回だけ', () => {
    expect(
      checkCallRoutes({
        policies: [policy()],
        endpointIds: endpoints,
        flowRouteIds: ['route-1', 'route-1'],
        knownCallRouteIds: new Set(['route-1']),
      }),
    ).toEqual([]);

    const dup = checkCallRoutes({
      policies: [policy()],
      endpointIds: endpoints,
      flowRouteIds: ['gone', 'gone'],
      knownCallRouteIds: new Set(),
    });
    expect(dup).toHaveLength(1);
  });

  it('旧ルートの実在集合が未提供なら参照は検査しない（取得できない環境で誤検知しない）', () => {
    expect(
      checkCallRoutes({ policies: [policy()], endpointIds: endpoints, flowRouteIds: ['gone'] }),
    ).toEqual([]);
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

describe('flowRouteIdsOf', () => {
  it('受付フローの callRouteId を集める', () => {
    expect(
      flowRouteIdsOf({
        receptionFlow: { flows: [{ id: 'f1', callRouteId: 'r1' }, { id: 'f2', callRouteId: 'r2' }] },
      }),
    ).toEqual(['r1', 'r2']);
  });

  it('未設定・空文字・型不正は無視する', () => {
    expect(
      flowRouteIdsOf({
        receptionFlow: { flows: [{ id: 'f1' }, { id: 'f2', callRouteId: '' }, { id: 'f3', callRouteId: 42 }] },
      }),
    ).toEqual([]);
    expect(flowRouteIdsOf({})).toEqual([]);
    expect(flowRouteIdsOf({ receptionFlow: null })).toEqual([]);
    expect(flowRouteIdsOf({ receptionFlow: { flows: 'nope' } })).toEqual([]);
  });
});
