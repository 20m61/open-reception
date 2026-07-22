import { describe, expect, it } from 'vitest';
import type { ContactEndpoint } from './endpoint';
import { createScriptedProvider } from './mock-provider';
import type { RoutingPolicy } from './policy';
import { runRouting } from './orchestrator';

function endpoint(id: string, over: Partial<ContactEndpoint> = {}): ContactEndpoint {
  return {
    id,
    ownerType: 'staff',
    ownerId: `owner-${id}`,
    channel: 'pstn',
    e164: '+819000000000',
    providerKey: 'mock',
    enabled: true,
    ...over,
  } as ContactEndpoint;
}

const e1 = endpoint('e1', { label: '個人携帯' });
const e2 = endpoint('e2', { label: '代理担当' });
const e3 = endpoint('e3', { ownerType: 'organization', label: '部門代表' });

const seqPolicy: RoutingPolicy = {
  id: 'p1',
  tenantId: 't1',
  name: '個人携帯→代理→部門代表',
  enabled: true,
  steps: [
    { id: 'personal', endpointId: 'e1', action: 'notify', timeoutSeconds: 20, nextOn: {} },
    { id: 'acting', endpointId: 'e2', action: 'notify', timeoutSeconds: 20, nextOn: {} },
    { id: 'department', endpointId: 'e3', action: 'announce_and_bridge', timeoutSeconds: 30, nextOn: {} },
  ],
};

describe('runRouting 順次取次 (#374)', () => {
  it('個人携帯→代理→部門代表の順で取り次ぎ、部門代表で応答して connected', async () => {
    const provider = createScriptedProvider({
      key: 'mock',
      resultFor: (id) => (id === 'e3' ? 'answered' : 'no_answer'),
    });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });

    expect(outcome.status).toBe('connected');
    expect(outcome.result).toBe('answered');
    expect(outcome.hops).toBe(3);
    expect(outcome.trace.map((t) => t.stepId)).toEqual(['personal', 'acting', 'department']);
    expect(outcome.trace.map((t) => t.result)).toEqual(['no_answer', 'no_answer', 'answered']);
    // provider は宣言順どおりに呼ばれる。
    expect(provider.calls.map((c) => c.endpointId)).toEqual(['e1', 'e2', 'e3']);
    expect(provider.calls.map((c) => c.action)).toEqual(['notify', 'notify', 'announce_and_bridge']);
  });

  it('誰も応答しなければ unreached で終了する', async () => {
    const provider = createScriptedProvider({ key: 'mock', whenExhausted: 'no_answer' });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });
    expect(outcome.status).toBe('unreached');
    expect(outcome.hops).toBe(3);
  });

  it('トレースにアドレス（e164）を載せない（PII 最小化）', async () => {
    const provider = createScriptedProvider({ key: 'mock', resultFor: () => 'answered' });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });
    expect(JSON.stringify(outcome.trace).includes('+819000000000')).toBe(false);
    expect(outcome.trace[0]).toMatchObject({ endpointId: 'e1', ownerType: 'staff', action: 'notify' });
  });
});

describe('runRouting 失敗理由別遷移 (#374)', () => {
  it('declined と no_answer で異なる次処理へ分岐する', async () => {
    // s1: declined→即終了(stop) / no_answer→s2 へ。
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

    const declinedRun = await runRouting({
      policies: [policy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2],
      providers: [createScriptedProvider({ key: 'mock', resultFor: () => 'declined' })],
      callUuid: 'c1',
    });
    // declined は即 stop なので s2 は呼ばれない。
    expect(declinedRun.status).toBe('unreached');
    expect(declinedRun.trace.map((t) => t.stepId)).toEqual(['s1']);

    const noAnswerRun = await runRouting({
      policies: [policy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2],
      providers: [createScriptedProvider({ key: 'mock', resultFor: (id) => (id === 'e2' ? 'answered' : 'no_answer') })],
      callUuid: 'c2',
    });
    // no_answer は s2 へ進み応答。
    expect(noAnswerRun.status).toBe('connected');
    expect(noAnswerRun.trace.map((t) => t.stepId)).toEqual(['s1', 's2']);
  });

  it('無効な Endpoint は failed として次へ進む（Provider を呼ばない）', async () => {
    const provider = createScriptedProvider({ key: 'mock', resultFor: (id) => (id === 'e2' ? 'answered' : 'no_answer') });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [endpoint('e1', { enabled: false }), e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });
    expect(outcome.status).toBe('connected');
    expect(outcome.trace[0]).toMatchObject({ stepId: 'personal', result: 'failed' });
    // 無効 Endpoint は provider を呼ばない。
    expect(provider.calls.map((c) => c.endpointId)).toEqual(['e2']);
  });

  it('Provider 未登録の Endpoint は failed として次へ進む', async () => {
    const provider = createScriptedProvider({ key: 'mock', resultFor: () => 'answered' });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [endpoint('e1', { providerKey: 'unknown' }), e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });
    expect(outcome.trace[0]).toMatchObject({ stepId: 'personal', result: 'failed' });
    expect(outcome.status).toBe('connected'); // e2 が answered
  });
});

describe('runRouting fallback route (#374)', () => {
  it('全 step 撃ち尽くし後に fallbackPolicy へ受け渡す', async () => {
    const primary: RoutingPolicy = {
      id: 'p1',
      tenantId: 't1',
      name: 'primary',
      enabled: true,
      fallbackPolicyId: 'p2',
      steps: [{ id: 's1', endpointId: 'e1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    };
    const fallback: RoutingPolicy = {
      id: 'p2',
      tenantId: 't1',
      name: 'fallback',
      enabled: true,
      steps: [{ id: 'f1', endpointId: 'e3', action: 'announce_and_bridge', timeoutSeconds: 30, nextOn: {} }],
    };
    const outcome = await runRouting({
      policies: [primary, fallback],
      entryPolicyId: 'p1',
      endpoints: [e1, e3],
      providers: [createScriptedProvider({ key: 'mock', resultFor: (id) => (id === 'e3' ? 'answered' : 'no_answer') })],
      callUuid: 'call-1',
    });
    expect(outcome.status).toBe('connected');
    expect(outcome.trace.map((t) => t.policyId)).toEqual(['p1', 'p2']);
    expect(outcome.trace.map((t) => t.stepId)).toEqual(['s1', 'f1']);
  });
});

describe('runRouting 無限取次の防止 (#374)', () => {
  it('goto の自己ループでも maxHops で必ず停止する（hop 上限を外すとハングして落ちる）', async () => {
    // s1: no_answer で自分自身へ goto。provider は常に no_answer → 静的には無限ループ。
    const looping: RoutingPolicy = {
      id: 'p1',
      tenantId: 't1',
      name: 'loop',
      enabled: true,
      steps: [
        {
          id: 's1',
          endpointId: 'e1',
          action: 'notify',
          timeoutSeconds: 20,
          nextOn: { no_answer: { kind: 'goto_step', stepId: 's1' } },
        },
      ],
    };
    const outcome = await runRouting({
      policies: [looping],
      entryPolicyId: 'p1',
      endpoints: [e1],
      providers: [createScriptedProvider({ key: 'mock', whenExhausted: 'no_answer' })],
      callUuid: 'call-1',
      maxHops: 5,
    });
    expect(outcome.status).toBe('exhausted');
    expect(outcome.reason).toBe('max_hops_exceeded');
    expect(outcome.hops).toBe(5);
  });

  it('存在しない entry ポリシーは no_entry_policy で即終了', async () => {
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'ghost',
      endpoints: [e1],
      providers: [createScriptedProvider({ key: 'mock' })],
      callUuid: 'call-1',
    });
    expect(outcome.status).toBe('unreached');
    expect(outcome.reason).toBe('no_entry_policy');
    expect(outcome.hops).toBe(0);
  });
});

describe('runRouting 冪等境界 (#374)', () => {
  it('Provider が重複 providerEventId を返したら二重処理せず打ち切る', async () => {
    // 1 手目は e1(no_answer)、2 手目 e2 で同じ event id を返す＝再配信相当。
    const provider = createScriptedProvider({
      key: 'mock',
      results: ['no_answer', 'answered'],
      eventIdFor: () => 'dup-evt', // 常に同一 id
    });
    const outcome = await runRouting({
      policies: [seqPolicy],
      entryPolicyId: 'p1',
      endpoints: [e1, e2, e3],
      providers: [provider],
      callUuid: 'call-1',
    });
    // 1 手目は処理されるが、2 手目の重複イベントで打ち切る（answered を二重に適用しない）。
    expect(outcome.status).toBe('exhausted');
    expect(outcome.reason).toBe('duplicate_event');
    expect(outcome.trace.map((t) => t.stepId)).toEqual(['personal']);
  });
});
