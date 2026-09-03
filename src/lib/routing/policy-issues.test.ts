import { describe, expect, it } from 'vitest';
import type { RoutingPolicyIssue } from '@/domain/routing/policy';
import { describeIssue, groupIssues } from './policy-issues';

describe('describeIssue', () => {
  it('各 issue を日本語の説明にする（アドレス等の機微値を含めない）', () => {
    expect(describeIssue({ kind: 'empty_policy', policyId: 'p' })).toContain('手順');
    expect(describeIssue({ kind: 'non_positive_timeout', policyId: 'p', stepId: 's1' })).toContain('待ち時間');
    expect(describeIssue({ kind: 'unknown_endpoint', policyId: 'p', stepId: 's1', endpointId: 'ep-x' })).toContain('接続先');
    expect(describeIssue({ kind: 'fallback_cycle', policyId: 'p' })).toContain('循環');
    expect(describeIssue({ kind: 'unknown_fallback_policy', policyId: 'p', targetPolicyId: 'q' })).toContain('引き継ぎ');
  });

  /**
   * 1 手あたりの上限超過 (#927)。**運用者が直せる形で言う**ため、
   * 「いま幾つで」「幾つまでか」の両方を出す（片方だけだと何秒にすればよいか分からない）。
   */
  it('上限超過は、設定値と上限の両方を示す', () => {
    const message = describeIssue({
      kind: 'exceeds_provider_ringing_timer',
      policyId: 'p',
      stepId: 's1',
      timeoutSeconds: 180,
      maxSeconds: 120,
    });
    expect(message).toContain('180');
    expect(message).toContain('120');
  });

  it('上限超過は step 別に表示される（ポリシー全体ではなく手順に紐づく）', () => {
    const grouped = groupIssues([
      {
        kind: 'exceeds_provider_ringing_timer',
        policyId: 'p',
        stepId: 's2',
        timeoutSeconds: 180,
        maxSeconds: 120,
      },
    ]);
    expect(grouped.byStep.s2).toHaveLength(1);
    expect(grouped.policyLevel).toEqual([]);
  });
});

describe('groupIssues', () => {
  it('step 付き issue は byStep、ポリシー全体の issue は policyLevel に振り分ける', () => {
    const issues: RoutingPolicyIssue[] = [
      { kind: 'empty_policy', policyId: 'p' },
      { kind: 'unknown_endpoint', policyId: 'p', stepId: 's1', endpointId: 'ep-x' },
      { kind: 'non_positive_timeout', policyId: 'p', stepId: 's1' },
      { kind: 'unknown_goto_step', policyId: 'p', stepId: 's2', targetStepId: 's9' },
      { kind: 'fallback_cycle', policyId: 'p' },
    ];
    const g = groupIssues(issues);
    expect(g.policyLevel.length).toBe(2); // empty_policy + fallback_cycle
    expect(g.byStep.s1).toHaveLength(2);
    expect(g.byStep.s2).toHaveLength(1);
  });

  it('空配列は空グルーピング', () => {
    const g = groupIssues([]);
    expect(g.policyLevel).toEqual([]);
    expect(Object.keys(g.byStep)).toEqual([]);
  });
});
