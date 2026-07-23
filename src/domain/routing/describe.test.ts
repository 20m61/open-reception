import { describe, expect, it } from 'vitest';
import { buildSeedRoutingPolicy } from './seed';
import { describeRoutingPolicy, describeRoutingPolicyText } from './describe';
import type { ContactEndpoint } from './endpoint';
import type { RoutingPolicy } from './policy';

const seedParams = {
  tenantId: 't1',
  providerKey: 'vonage',
  personalMobile: { endpointId: 'ep-personal', ownerId: 'staff-1', e164: '+819011112222', label: '山田の個人携帯' },
  actingContact: { endpointId: 'ep-acting', ownerId: 'staff-2', e164: '+819033334444', label: '佐藤（代理）' },
  departmentRepresentative: { endpointId: 'ep-dept', ownerId: 'org-1', e164: '+81312345678', label: '総務代表' },
};

describe('describeRoutingPolicy (#374)', () => {
  it('seed ルートを非エンジニア向けの手順文へ落とす', () => {
    const { policy, endpoints } = buildSeedRoutingPolicy(seedParams);
    expect(describeRoutingPolicy(policy, endpoints)).toEqual([
      '「個人携帯→代理→部門代表」の順で取り次ぎます。',
      '1. まず 山田の個人携帯へ通知します（20秒待つ）。繋がらなければ次へ進みます。',
      '2. 次に 佐藤（代理）へ通知します（20秒待つ）。繋がらなければ次へ進みます。',
      '3. 最後に 総務代表へ読み上げてからつなぎます（30秒待つ）。ここまでで繋がらなければ取次を終了します。',
    ]);
  });

  it('アドレス（e164）を文章へ出さない（PII 最小化）', () => {
    const { policy, endpoints } = buildSeedRoutingPolicy(seedParams);
    expect(describeRoutingPolicyText(policy, endpoints).includes('+819011112222')).toBe(false);
  });

  it('label 未設定の Endpoint は endpointId で代替し、アドレスは出さない', () => {
    const endpoints: ContactEndpoint[] = [
      { id: 'ep-x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+819000000000', providerKey: 'vonage', enabled: true },
    ];
    const policy: RoutingPolicy = {
      id: 'p1',
      tenantId: 't1',
      name: 'r',
      enabled: true,
      steps: [{ id: 's1', endpointId: 'ep-x', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    };
    const text = describeRoutingPolicyText(policy, endpoints);
    expect(text.includes('ep-x')).toBe(true);
    expect(text.includes('+819000000000')).toBe(false);
  });

  it('結果別の明示遷移（nextOn）を補足する', () => {
    const endpoints: ContactEndpoint[] = [
      { id: 'e1', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+819000000001', providerKey: 'vonage', enabled: true, label: '担当A' },
      { id: 'e2', ownerType: 'staff', ownerId: 's2', channel: 'pstn', e164: '+819000000002', providerKey: 'vonage', enabled: true, label: '担当B' },
    ];
    const policy: RoutingPolicy = {
      id: 'p1',
      tenantId: 't1',
      name: 'branch',
      enabled: true,
      steps: [
        {
          id: 's1',
          endpointId: 'e1',
          action: 'notify',
          timeoutSeconds: 20,
          nextOn: { declined: { kind: 'stop' } },
        },
        { id: 's2', endpointId: 'e2', action: 'notify', timeoutSeconds: 20, nextOn: {} },
      ],
    };
    const lines = describeRoutingPolicy(policy, endpoints);
    expect(lines[1]).toBe('1. まず 担当Aへ通知します（20秒待つ）。繋がらなければ次へ進みます。（拒否のときは取次を終了します）');
  });
});
