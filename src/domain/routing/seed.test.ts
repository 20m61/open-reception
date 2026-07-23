import { describe, expect, it } from 'vitest';
import { buildSeedRoutingPolicy } from './seed';
import { validateRoutingPolicySet } from './policy';
import { runRouting } from './orchestrator';
import { createScriptedProvider } from './mock-provider';

const params = {
  tenantId: 't1',
  siteId: 'site-1',
  providerKey: 'vonage',
  personalMobile: { endpointId: 'ep-personal', ownerId: 'staff-1', e164: '+819011112222', label: '山田の個人携帯' },
  actingContact: { endpointId: 'ep-acting', ownerId: 'staff-2', e164: '+819033334444', label: '佐藤（代理）' },
  departmentRepresentative: { endpointId: 'ep-dept', ownerId: 'org-1', e164: '+81312345678', label: '総務代表' },
};

describe('buildSeedRoutingPolicy (#374)', () => {
  it('個人携帯→代理→部門代表の 3 手を宣言順どおり作る', () => {
    const { policy } = buildSeedRoutingPolicy(params);
    expect(policy.steps.map((s) => s.id)).toEqual(['personal', 'acting', 'department']);
    expect(policy.steps.map((s) => s.endpointId)).toEqual(['ep-personal', 'ep-acting', 'ep-dept']);
    expect(policy.steps.map((s) => s.action)).toEqual(['notify', 'notify', 'announce_and_bridge']);
    expect(policy.steps.map((s) => s.timeoutSeconds)).toEqual([20, 20, 30]);
  });

  it('Endpoint の owner 種別が個人=staff・部門=organization になる', () => {
    const { endpoints } = buildSeedRoutingPolicy(params);
    expect(endpoints.map((e) => e.ownerType)).toEqual(['staff', 'staff', 'organization']);
  });

  it('生成物は validateRoutingPolicySet を通る', () => {
    const { policy, endpoints } = buildSeedRoutingPolicy(params);
    const endpointIds = new Set(endpoints.map((e) => e.id));
    expect(validateRoutingPolicySet([policy], endpointIds)).toEqual([]);
  });

  it('Orchestrator で個人携帯・代理が応答なし→部門代表で応答して connected', async () => {
    const { policy, endpoints } = buildSeedRoutingPolicy(params);
    const provider = createScriptedProvider({
      key: 'vonage',
      resultFor: (id) => (id === 'ep-dept' ? 'answered' : 'no_answer'),
    });
    const outcome = await runRouting({
      policies: [policy],
      entryPolicyId: policy.id,
      endpoints,
      providers: [provider],
      callUuid: 'call-seed',
    });
    expect(outcome.status).toBe('connected');
    expect(outcome.trace.map((t) => t.stepId)).toEqual(['personal', 'acting', 'department']);
  });

  it('個人携帯が即応答すれば代理・部門は呼ばれない', async () => {
    const { policy, endpoints } = buildSeedRoutingPolicy(params);
    const provider = createScriptedProvider({
      key: 'vonage',
      resultFor: (id) => (id === 'ep-personal' ? 'answered' : 'no_answer'),
    });
    const outcome = await runRouting({
      policies: [policy],
      entryPolicyId: policy.id,
      endpoints,
      providers: [provider],
      callUuid: 'call-seed',
    });
    expect(outcome.status).toBe('connected');
    expect(outcome.trace.map((t) => t.stepId)).toEqual(['personal']);
    expect(provider.calls.map((c) => c.endpointId)).toEqual(['ep-personal']);
  });
});
