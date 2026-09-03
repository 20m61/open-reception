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
   * #927: 1 手あたりの上限。**丸められることまで言う**必要がある。
   *
   * 「上限は 120 秒です」だけだと、既に 180 秒で運用している人は「今まで動いていたのに」と
   * 読む。実際には最初から 120 秒で動いていて、表示だけが違っていた。
   */
  it('provider 上限の超過は、上限値と「丸められる」ことの両方を伝える', () => {
    /*
     * id は**必ず本文に出ない形**の値にする。`'p'` / `'s1'` のような短い値で
     * `not.toContain` を書くと、文面をいじった拍子に偶然当たって落ちる（主張ではなく
     * 綴りを縛ってしまう）。
     */
    const message = describeIssue({
      kind: 'step_timeout_exceeds_provider_max',
      policyId: 'policy-must-not-appear',
      stepId: 'step-must-not-appear',
      maxSeconds: 120,
    });
    // 上限値を出す（運用者が直す先の数値が分からないと直せない）。
    expect(message).toContain('120');
    // 「超えたら弾かれる」ではなく「超えても丸められる」を伝える。
    expect(message).toContain('次の手順へ進みます');
    // 機微値（ポリシー id / step id）を文面へ出さない（他の issue と同じ扱い）。
    expect(message).not.toContain('policy-must-not-appear');
    expect(message).not.toContain('step-must-not-appear');
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

  /*
   * #927 は**どの手順が悪いか**が分からないと直せない（1 手だけ長い構成で出るため）。
   * `stepId` を持たせた意味がここにある —— ポリシー全体の欄に出ると、手順が 10 個ある
   * ルートで運用者は総当たりすることになる。
   */
  it('provider 上限の超過は step 別に振り分けられる (#927)', () => {
    const g = groupIssues([
      { kind: 'step_timeout_exceeds_provider_max', policyId: 'p', stepId: 's3', maxSeconds: 120 },
    ]);
    expect(g.policyLevel).toEqual([]);
    expect(g.byStep.s3).toHaveLength(1);
  });

  it('空配列は空グルーピング', () => {
    const g = groupIssues([]);
    expect(g.policyLevel).toEqual([]);
    expect(Object.keys(g.byStep)).toEqual([]);
  });
});
