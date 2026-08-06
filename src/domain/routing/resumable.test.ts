import { describe, expect, it } from 'vitest';
import type { RoutingPolicy } from './policy';
import { advanceRouting, startRouting, type RoutingPosition } from './resumable';

function step(id: string, endpointId: string, over: Partial<RoutingPolicy['steps'][number]> = {}) {
  return { id, endpointId, action: 'notify' as const, timeoutSeconds: 20, nextOn: {}, ...over };
}

const POLICY: RoutingPolicy = {
  id: 'p1',
  tenantId: 't1',
  name: 'TEST-policy',
  enabled: true,
  steps: [step('s1', 'e1'), step('s2', 'e2'), step('s3', 'e3')],
};

const POLICIES = [POLICY];
const CALL = 'TEST-call-uuid';

/** dial を期待して position と step を取り出す。 */
function expectDial(advance: ReturnType<typeof startRouting>) {
  expect(advance.kind).toBe('dial');
  if (advance.kind !== 'dial') throw new Error('not a dial');
  return advance;
}

describe('startRouting — 最初の 1 手 (#4)', () => {
  it('entry ポリシーの先頭 step を発信する', () => {
    const first = expectDial(startRouting(POLICIES, 'p1', CALL));
    expect(first.step.id).toBe('s1');
    expect(first.position).toMatchObject({ callUuid: CALL, policyId: 'p1', stepId: 's1', hops: 0 });
  });

  it('entry ポリシーが無ければ確定（発信しない）', () => {
    expect(startRouting(POLICIES, 'missing', CALL)).toMatchObject({
      kind: 'settled',
      reason: 'no_entry_policy',
    });
  });

  it('step が空のポリシーは確定（ハングしない）', () => {
    const empty: RoutingPolicy = { ...POLICY, id: 'p0', steps: [] };
    expect(startRouting([empty], 'p0', CALL)).toMatchObject({ kind: 'settled' });
  });
});

describe('advanceRouting — webhook 1 件で 1 歩進む (#4)', () => {
  const first = expectDial(startRouting(POLICIES, 'p1', CALL));

  it('繋がったら確定して次を発信しない', () => {
    const advance = advanceRouting(first.position, POLICIES, 'answered', 'ev-1');
    expect(advance).toMatchObject({ kind: 'settled', result: 'answered' });
  });

  it('未応答なら次の step を発信する', () => {
    const next = expectDial(advanceRouting(first.position, POLICIES, 'no_answer', 'ev-1'));
    expect(next.step.id).toBe('s2');
    expect(next.position.hops).toBe(1);
  });

  it('末尾まで撃ち尽くしたら確定する', () => {
    let position: RoutingPosition = first.position;
    for (const [i, expected] of ['s2', 's3'].entries()) {
      const next = expectDial(advanceRouting(position, POLICIES, 'no_answer', `ev-${i}`));
      expect(next.step.id).toBe(expected);
      position = next.position;
    }
    expect(advanceRouting(position, POLICIES, 'no_answer', 'ev-last')).toMatchObject({
      kind: 'settled',
      result: 'no_answer',
    });
  });

  it('nextOn の明示指定に従う（stop で止める）', () => {
    const stopping: RoutingPolicy = {
      ...POLICY,
      steps: [step('s1', 'e1', { nextOn: { no_answer: { kind: 'stop' } } }), step('s2', 'e2')],
    };
    const start = expectDial(startRouting([stopping], 'p1', CALL));
    expect(advanceRouting(start.position, [stopping], 'no_answer', 'ev-1')).toMatchObject({
      kind: 'settled',
    });
  });

  it('fallback ポリシーへ受け渡す', () => {
    const main: RoutingPolicy = { ...POLICY, steps: [step('s1', 'e1')], fallbackPolicyId: 'p2' };
    const fallback: RoutingPolicy = { ...POLICY, id: 'p2', steps: [step('f1', 'e9')] };
    const start = expectDial(startRouting([main, fallback], 'p1', CALL));
    const next = expectDial(advanceRouting(start.position, [main, fallback], 'no_answer', 'ev-1'));
    expect(next.position.policyId).toBe('p2');
    expect(next.step.id).toBe('f1');
  });
});

describe('冪等: 同じ webhook が二度届いても取次を進めない (#4)', () => {
  const first = expectDial(startRouting(POLICIES, 'p1', CALL));

  it('同一 providerEventId の再配信は duplicate として何もしない', () => {
    const once = expectDial(advanceRouting(first.position, POLICIES, 'no_answer', 'ev-dup'));
    const twice = advanceRouting(once.position, POLICIES, 'no_answer', 'ev-dup');
    expect(twice).toMatchObject({ kind: 'duplicate' });
  });

  // 🔴 これが無いと、Vonage の at-least-once 配信で取次が余計に 1 手進み、
  // 担当者が応答していないのに次の人（部門代表等）へ勝手に発信される。
  it('duplicate は position を進めない', () => {
    const once = expectDial(advanceRouting(first.position, POLICIES, 'no_answer', 'ev-dup2'));
    const twice = advanceRouting(once.position, POLICIES, 'no_answer', 'ev-dup2');
    expect(twice.kind).toBe('duplicate');
    // 呼び出し側は position を保存し直さない＝ hop が増えない。
    expect(once.position.hops).toBe(1);
  });

  it('別の providerEventId なら進む', () => {
    const once = expectDial(advanceRouting(first.position, POLICIES, 'no_answer', 'ev-a'));
    expect(advanceRouting(once.position, POLICIES, 'no_answer', 'ev-b').kind).toBe('dial');
  });
});

describe('ハングしない上限 (#4)', () => {
  it('hop 上限に達したら確定する', () => {
    const loop: RoutingPolicy = {
      ...POLICY,
      steps: [step('s1', 'e1', { nextOn: { no_answer: { kind: 'goto_step', stepId: 's1' } } })],
    };
    let position = expectDial(startRouting([loop], 'p1', CALL)).position;
    let settled: string | undefined;
    for (let i = 0; i < 50; i++) {
      const advance = advanceRouting(position, [loop], 'no_answer', `ev-${i}`, { maxHops: 5 });
      if (advance.kind === 'settled') {
        settled = advance.reason;
        break;
      }
      if (advance.kind !== 'dial') throw new Error('unexpected');
      position = advance.position;
    }
    expect(settled).toBe('max_hops_exceeded');
  });

  // 🔴 何手目で止まるかを固定する。`>=` を `>` にする変異が素通りしていた
  // （50 回ループして最後に settled になることしか見ていなかった）。
  // 1 手 = 実在の人の携帯が 1 回鳴る + PSTN 1 通話ぶんの課金。
  it('maxHops=2 なら dial は 1 回だけ、2 回目で確定する', () => {
    const loop: RoutingPolicy = {
      ...POLICY,
      steps: [step('s1', 'e1', { nextOn: { no_answer: { kind: 'goto_step', stepId: 's1' } } })],
    };
    const start = expectDial(startRouting([loop], 'p1', CALL));
    const second = advanceRouting(start.position, [loop], 'no_answer', 'ev-1', { maxHops: 2 });
    expect(second.kind).toBe('dial');
    if (second.kind !== 'dial') throw new Error('expected dial');
    expect(advanceRouting(second.position, [loop], 'no_answer', 'ev-2', { maxHops: 2 })).toMatchObject({
      kind: 'settled',
      reason: 'max_hops_exceeded',
    });
  });

  // 🔴 上限判定より先に「繋がった」を確定させないと、最後の 1 手で応答したときに
  // max_hops_exceeded になり、**担当者が出たのに未達として扱われる**。
  it('上限に達した手で繋がったら、上限ではなく成功として確定する', () => {
    const loop: RoutingPolicy = {
      ...POLICY,
      steps: [step('s1', 'e1', { nextOn: { no_answer: { kind: 'goto_step', stepId: 's1' } } })],
    };
    let position = expectDial(startRouting([loop], 'p1', CALL)).position;
    const next = advanceRouting(position, [loop], 'no_answer', 'ev-0', { maxHops: 2 });
    if (next.kind !== 'dial') throw new Error('expected dial');
    position = next.position;
    expect(advanceRouting(position, [loop], 'answered', 'ev-1', { maxHops: 2 })).toMatchObject({
      kind: 'settled',
      result: 'answered',
      reason: 'stopped',
    });
  });

  it('goto 先が存在しない（dangling）なら確定する', () => {
    const dangling: RoutingPolicy = {
      ...POLICY,
      steps: [step('s1', 'e1', { nextOn: { no_answer: { kind: 'goto_step', stepId: 'nope' } } })],
    };
    const start = expectDial(startRouting([dangling], 'p1', CALL));
    expect(advanceRouting(start.position, [dangling], 'no_answer', 'ev-1')).toMatchObject({
      kind: 'settled',
      reason: 'dangling_step',
    });
  });

  it('fallback 先が存在しないなら確定する', () => {
    const missing: RoutingPolicy = { ...POLICY, steps: [step('s1', 'e1')], fallbackPolicyId: 'gone' };
    const start = expectDial(startRouting([missing], 'p1', CALL));
    expect(advanceRouting(start.position, [missing], 'no_answer', 'ev-1')).toMatchObject({
      kind: 'settled',
    });
  });
});

describe('position は永続化できる形 (#4)', () => {
  it('JSON 往復しても同じように進む（DynamoDB へ載せられる）', () => {
    const first = expectDial(startRouting(POLICIES, 'p1', CALL));
    const revived: RoutingPosition = JSON.parse(JSON.stringify(first.position));
    const next = expectDial(advanceRouting(revived, POLICIES, 'no_answer', 'ev-1'));
    expect(next.step.id).toBe('s2');
  });

  it('往復後も冪等台帳が効く', () => {
    const first = expectDial(startRouting(POLICIES, 'p1', CALL));
    const once = expectDial(advanceRouting(first.position, POLICIES, 'no_answer', 'ev-x'));
    const revived: RoutingPosition = JSON.parse(JSON.stringify(once.position));
    expect(advanceRouting(revived, POLICIES, 'no_answer', 'ev-x').kind).toBe('duplicate');
  });
});
