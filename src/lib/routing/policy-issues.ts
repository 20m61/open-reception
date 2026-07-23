/**
 * ルーティングポリシー検証 issue の表示ヘルパ (issue #374, 残 increment)。
 *
 * `validateRoutingPolicySet`（`@/domain/routing/policy`）が返す構造 issue を、非エンジニア向けの
 * 日本語メッセージへ落とし、文章形式ルートビルダー UI が **フィールド別（step 別）** に表示できる
 * ようにグルーピングする純関数。UI（クライアント）から使うため副作用なし・機微値を含めない。
 */
import type { RoutingPolicyIssue } from '@/domain/routing/policy';

/** issue 1 件を日本語の説明文にする。 */
export function describeIssue(issue: RoutingPolicyIssue): string {
  switch (issue.kind) {
    case 'empty_policy':
      return '取次の手順が空です。1 つ以上の接続先を追加してください。';
    case 'duplicate_step_id':
      return '手順の識別子が重複しています。';
    case 'non_positive_timeout':
      return '待ち時間は 1 秒以上の整数で指定してください。';
    case 'unknown_endpoint':
      return '選択された接続先が登録されていません。接続先一覧から選び直してください。';
    case 'unknown_goto_step':
      return '遷移先の手順が見つかりません。存在する手順を指定してください。';
    case 'unknown_fallback_policy':
      return '引き継ぎ先の別ルートが見つかりません。存在するルートを指定してください。';
    case 'fallback_cycle':
      return 'ルートの引き継ぎが循環しています。無限取次になるため保存できません。';
  }
}

export type GroupedIssues = {
  /** ポリシー全体に関わる問題（手順に紐づかない）。 */
  policyLevel: string[];
  /** step.id ごとの問題メッセージ。 */
  byStep: Record<string, string[]>;
};

/** issue 群を「ポリシー全体」と「step 別」に振り分ける。 */
export function groupIssues(issues: ReadonlyArray<RoutingPolicyIssue>): GroupedIssues {
  const policyLevel: string[] = [];
  const byStep: Record<string, string[]> = {};
  for (const issue of issues) {
    const message = describeIssue(issue);
    if ('stepId' in issue && typeof issue.stepId === 'string') {
      (byStep[issue.stepId] ??= []).push(message);
    } else {
      policyLevel.push(message);
    }
  }
  return { policyLevel, byStep };
}
