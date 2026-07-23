import { describe, expect, it } from 'vitest';
import { asCallRouteId, type CallRoute } from '@/domain/notification/call-route';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { routingFromCallRoute } from './compat';
import { validateRoutingPolicySet } from './policy';

function callRoute(over: Partial<CallRoute> = {}): CallRoute {
  return {
    id: asCallRouteId('route-1'),
    tenantId: asTenantId('t1'),
    siteId: asSiteId('site-1'),
    name: '受付端末A ルート',
    enabled: true,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    groups: [
      {
        label: '一次',
        targets: [
          { label: '個人携帯', channel: 'phone', value: '+819012345678', priority: 1 },
          { label: '代表', channel: 'phone', value: '+81312345678', priority: 0 },
        ],
      },
      {
        label: '二次',
        targets: [{ label: '部門代表', channel: 'phone', value: '+81398765432', priority: 0 }],
      },
    ],
    ...over,
  };
}

describe('routingFromCallRoute (#374)', () => {
  it('group 順・group 内 priority 昇順で step を作る', () => {
    const { policy, endpoints } = routingFromCallRoute(callRoute());
    // 一次グループ内は priority 0(代表) → 1(個人携帯)、その後二次(部門代表)。
    expect(policy.steps.map((s) => s.endpointId)).toEqual([
      'route-1:g0:t0',
      'route-1:g0:t1',
      'route-1:g1:t0',
    ]);
    const labels = endpoints.map((e) => e.label);
    expect(labels).toEqual(['代表', '個人携帯', '部門代表']);
  });

  it('生成した Endpoint はすべて pstn で e164 を保持する', () => {
    const { endpoints } = routingFromCallRoute(callRoute());
    expect(endpoints.every((e) => e.channel === 'pstn')).toBe(true);
    const first = endpoints[0];
    expect(first).toBeDefined();
    if (first === undefined || first.channel !== 'pstn') throw new Error('expected a pstn endpoint');
    expect(first.e164).toBe('+81312345678');
    expect(first.providerKey).toBe('vonage');
  });

  it('policy は tenant/site 境界と enabled を引き継ぐ', () => {
    const { policy } = routingFromCallRoute(callRoute({ enabled: false }));
    expect(policy).toMatchObject({ id: 'compat:route-1', tenantId: 't1', siteId: 'site-1', enabled: false });
  });

  it('phone 以外のチャネルは step にせず skipped で返す', () => {
    const route = callRoute({
      groups: [
        {
          label: '一次',
          targets: [
            { label: '個人携帯', channel: 'phone', value: '+819012345678', priority: 0 },
            { label: 'メール', channel: 'email', value: 'a@example.com', priority: 1 },
          ],
        },
      ],
    });
    const { policy, skipped } = routingFromCallRoute(route);
    expect(policy.steps).toHaveLength(1);
    expect(skipped).toEqual([
      { groupLabel: '一次', targetLabel: 'メール', channel: 'email', reason: 'unsupported_channel' },
    ]);
  });

  it('E.164 でない電話番号は invalid_address として skipped、アドレスは skipped に含めない', () => {
    const route = callRoute({
      groups: [
        {
          label: '一次',
          targets: [{ label: '内線', channel: 'phone', value: '1234', priority: 0 }],
        },
      ],
    });
    const { policy, skipped } = routingFromCallRoute(route);
    expect(policy.steps).toHaveLength(0);
    expect(skipped).toEqual([
      { groupLabel: '一次', targetLabel: '内線', channel: 'phone', reason: 'invalid_address' },
    ]);
    expect(JSON.stringify(skipped).includes('1234')).toBe(false);
  });

  it('生成物は validateRoutingPolicySet を通る（整合した Endpoint と step）', () => {
    const { policy, endpoints } = routingFromCallRoute(callRoute());
    const endpointIds = new Set(endpoints.map((e) => e.id));
    expect(validateRoutingPolicySet([policy], endpointIds)).toEqual([]);
  });

  it('入力 CallRoute を変更しない（非破壊）', () => {
    const route = callRoute();
    const snapshot = JSON.stringify(route);
    routingFromCallRoute(route);
    expect(JSON.stringify(route)).toBe(snapshot);
  });
});
