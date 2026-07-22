import { describe, expect, it } from 'vitest';
import {
  findAllFallbackCycleIds,
  isTerminalSuccess,
  nextTransition,
  validateRoutingPolicySet,
  type RoutingPolicy,
} from './policy';

function policy(partial: Partial<RoutingPolicy> & Pick<RoutingPolicy, 'id' | 'steps'>): RoutingPolicy {
  return {
    tenantId: 't1',
    name: partial.id,
    enabled: true,
    ...partial,
  };
}

const threeStep = policy({
  id: 'p1',
  steps: [
    { id: 's1', endpointId: 'e1', action: 'notify', timeoutSeconds: 20, nextOn: {} },
    { id: 's2', endpointId: 'e2', action: 'notify', timeoutSeconds: 20, nextOn: {} },
    { id: 's3', endpointId: 'e3', action: 'announce_and_bridge', timeoutSeconds: 30, nextOn: {} },
  ],
});

describe('isTerminalSuccess (#374)', () => {
  it('answered/accepted/staff_coming は成功終端', () => {
    expect(isTerminalSuccess('answered')).toBe(true);
    expect(isTerminalSuccess('accepted')).toBe(true);
    expect(isTerminalSuccess('staff_coming')).toBe(true);
  });
  it('busy/no_answer/declined/failed は継続可能', () => {
    for (const r of ['busy', 'no_answer', 'declined', 'failed'] as const) {
      expect(isTerminalSuccess(r)).toBe(false);
    }
  });
});

describe('nextTransition 既定遷移 (#374)', () => {
  it('成功結果は既定で stop', () => {
    expect(nextTransition(threeStep, 0, 'answered')).toEqual({ kind: 'stop' });
  });
  it('継続可能な結果は既定で次 step へ', () => {
    expect(nextTransition(threeStep, 0, 'no_answer')).toEqual({ kind: 'goto_step', stepId: 's2' });
    expect(nextTransition(threeStep, 1, 'busy')).toEqual({ kind: 'goto_step', stepId: 's3' });
  });
  it('末尾 step で fallback 無しなら stop', () => {
    expect(nextTransition(threeStep, 2, 'no_answer')).toEqual({ kind: 'stop' });
  });
  it('末尾 step で fallbackPolicyId があればそれへ受け渡す', () => {
    const withFallback = { ...threeStep, fallbackPolicyId: 'p2' };
    expect(nextTransition(withFallback, 2, 'failed')).toEqual({
      kind: 'fallback_policy',
      policyId: 'p2',
    });
  });
  it('nextOn の明示遷移は既定より優先される', () => {
    const p = policy({
      id: 'p1',
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
    });
    // 既定なら s2 へ進むが、declined は明示的に stop。
    expect(nextTransition(p, 0, 'declined')).toEqual({ kind: 'stop' });
    expect(nextTransition(p, 0, 'no_answer')).toEqual({ kind: 'goto_step', stepId: 's2' });
  });
});

describe('findAllFallbackCycleIds (#374)', () => {
  it('循環が無ければ空', () => {
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'b' });
    const b = policy({ id: 'b', steps: threeStep.steps });
    expect(findAllFallbackCycleIds([a, b]).size).toBe(0);
  });

  it('a→b→a の 2 者循環を全件検出する', () => {
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'b' });
    const b = policy({ id: 'b', steps: threeStep.steps, fallbackPolicyId: 'a' });
    expect(findAllFallbackCycleIds([a, b])).toEqual(new Set(['a', 'b']));
  });

  it('自己 fallback（a→a）も循環', () => {
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'a' });
    expect(findAllFallbackCycleIds([a])).toEqual(new Set(['a']));
  });

  it('循環に流入する非循環ノードは巻き込まない', () => {
    // c→a, a→b, b→a: a,b が循環、c は循環外。
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'b' });
    const b = policy({ id: 'b', steps: threeStep.steps, fallbackPolicyId: 'a' });
    const c = policy({ id: 'c', steps: threeStep.steps, fallbackPolicyId: 'a' });
    expect(findAllFallbackCycleIds([a, b, c])).toEqual(new Set(['a', 'b']));
  });

  it('独立した 2 つの循環を両方検出する', () => {
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'b' });
    const b = policy({ id: 'b', steps: threeStep.steps, fallbackPolicyId: 'a' });
    const c = policy({ id: 'c', steps: threeStep.steps, fallbackPolicyId: 'd' });
    const d = policy({ id: 'd', steps: threeStep.steps, fallbackPolicyId: 'c' });
    expect(findAllFallbackCycleIds([a, b, c, d])).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});

describe('validateRoutingPolicySet (#374)', () => {
  const endpointIds = new Set(['e1', 'e2', 'e3']);

  it('健全なポリシー集合は問題無し', () => {
    expect(validateRoutingPolicySet([threeStep], endpointIds)).toEqual([]);
  });

  it('未登録 Endpoint を検出する', () => {
    const p = policy({
      id: 'p1',
      steps: [{ id: 's1', endpointId: 'missing', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    });
    expect(validateRoutingPolicySet([p], endpointIds)).toContainEqual({
      kind: 'unknown_endpoint',
      policyId: 'p1',
      stepId: 's1',
      endpointId: 'missing',
    });
  });

  it('非正のタイムアウトを検出する', () => {
    const p = policy({
      id: 'p1',
      steps: [{ id: 's1', endpointId: 'e1', action: 'notify', timeoutSeconds: 0, nextOn: {} }],
    });
    expect(validateRoutingPolicySet([p], endpointIds)).toContainEqual({
      kind: 'non_positive_timeout',
      policyId: 'p1',
      stepId: 's1',
    });
  });

  it('空ポリシーを検出する', () => {
    const p = policy({ id: 'p1', steps: [] });
    expect(validateRoutingPolicySet([p], endpointIds)).toContainEqual({
      kind: 'empty_policy',
      policyId: 'p1',
    });
  });

  it('未登録 goto 先を検出する', () => {
    const p = policy({
      id: 'p1',
      steps: [
        {
          id: 's1',
          endpointId: 'e1',
          action: 'notify',
          timeoutSeconds: 20,
          nextOn: { no_answer: { kind: 'goto_step', stepId: 'ghost' } },
        },
      ],
    });
    expect(validateRoutingPolicySet([p], endpointIds)).toContainEqual({
      kind: 'unknown_goto_step',
      policyId: 'p1',
      stepId: 's1',
      targetStepId: 'ghost',
    });
  });

  it('未登録 fallback ポリシーを検出する', () => {
    const p = policy({ id: 'p1', steps: threeStep.steps, fallbackPolicyId: 'nope' });
    expect(validateRoutingPolicySet([p], endpointIds)).toContainEqual({
      kind: 'unknown_fallback_policy',
      policyId: 'p1',
      targetPolicyId: 'nope',
    });
  });

  it('fallback 循環を検出する（検出を外すと落ちる強い assertion）', () => {
    const a = policy({ id: 'a', steps: threeStep.steps, fallbackPolicyId: 'b' });
    const b = policy({ id: 'b', steps: threeStep.steps, fallbackPolicyId: 'a' });
    const issues = validateRoutingPolicySet([a, b], endpointIds);
    expect(issues).toContainEqual({ kind: 'fallback_cycle', policyId: 'a' });
    expect(issues).toContainEqual({ kind: 'fallback_cycle', policyId: 'b' });
  });
});
