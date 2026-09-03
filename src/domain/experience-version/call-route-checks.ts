/**
 * 取次（call route）到達性の公開前検証 (issue #420「call route reachability contract」)。
 *
 * **どのモデルを検査するか**を先に決める必要があった。取次には 2 つのモデルが並存している
 * （移行台帳 §5 の重複概念）:
 *
 *   - `RoutingPolicy` / `ContactEndpoint`（`src/domain/routing/`, #374）… **実際の呼び出しが使う**。
 *     `executeRoutedCall`（`src/lib/routing/call-execution.ts`）が解決する。
 *   - `CallRoute`（`src/domain/notification/call-route.ts`, #88）… 受付フローの `callRouteId` が
 *     指す旧モデル。**現在の呼び出し経路は参照していない**（admin の編集画面と永続化のみ）。
 *
 * したがって「呼び出しても誰にも届かない」を検出できるのは前者だけで、後者は設定の不整合
 * （運用者の意図が効いていない）に留まる。severity をこの差に対応させる。
 *
 * 検査そのものは `validateRoutingPolicySet`（`src/domain/routing/policy.ts`）が既に持っている
 * ので、ここはその結果を運用者向けの指摘へ写すだけにする（判定を二重実装しない）。
 */
import type { RoutingPolicy, RoutingPolicyIssue } from '@/domain/routing/policy';
import { validateRoutingPolicySet } from '@/domain/routing/policy';
import type { ValidationFinding } from './types';

/** 指摘メッセージ。**ID は載せるが宛先（電話番号・URI）は載せない**（機微情報）。 */
function messageFor(issue: RoutingPolicyIssue): string {
  switch (issue.kind) {
    case 'empty_policy':
      return `取次ポリシー ${issue.policyId} に手順がありません（誰にも呼び出しが届きません）`;
    case 'duplicate_step_id':
      return `取次ポリシー ${issue.policyId} に重複した手順 ID ${issue.stepId} があります`;
    case 'non_positive_timeout':
      return `取次ポリシー ${issue.policyId} の手順 ${issue.stepId} のタイムアウトが不正です`;
    case 'unknown_endpoint':
      return `取次ポリシー ${issue.policyId} の手順 ${issue.stepId} が存在しない呼び出し先 ${issue.endpointId} を指しています`;
    case 'unknown_goto_step':
      return `取次ポリシー ${issue.policyId} の手順 ${issue.stepId} が存在しない手順 ${issue.targetStepId} へ遷移します`;
    case 'unknown_fallback_policy':
      return `取次ポリシー ${issue.policyId} が存在しないフォールバック先 ${issue.targetPolicyId} を指しています`;
    case 'fallback_cycle':
      return `取次ポリシー ${issue.policyId} のフォールバックが循環しています`;
    case 'step_timeout_exceeds_provider_max':
      return `取次ポリシー ${issue.policyId} の手順 ${issue.stepId} の待ち時間が電話事業者の上限（${issue.maxSeconds} 秒）を超えています（表示より早く次の手順へ進みます）`;
    case 'exceeds_client_wait':
      return `取次ポリシー ${issue.policyId} は最後まで呼び出すと受付端末の待ち時間の上限を超えます（来訪者が代替のご案内へ進んだあとも呼び出しが続きます）`;
  }
}

export type CallRouteCheckInput = {
  /** 対象拠点で有効な取次ポリシー。 */
  policies: readonly RoutingPolicy[];
  /** 実在する呼び出し先 ID の集合。 */
  endpointIds: ReadonlySet<string>;
};

export function checkCallRoutes(input: CallRouteCheckInput): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // 取次契約の破れは **error**。呼び出しても届かない状態で公開させない。
  for (const issue of validateRoutingPolicySet(input.policies, input.endpointIds)) {
    findings.push({ check: 'call_route', severity: 'error', message: messageFor(issue) });
  }

  // 有効なポリシーがゼロは **warning**。実行時は従来の単一呼び出しへフォールバックするため
  // 受付自体は完遂する（`executeRoutedCall` が null を返すと `startCall` が既定アダプタで走る）。
  // 「取次設定が効いていない」ことは運用者に伝える価値がある。
  if (input.policies.length === 0) {
    findings.push({
      check: 'call_route',
      severity: 'warning',
      message: '有効な取次ポリシーがありません（既定の単一呼び出しで動作します）',
    });
  }

  // 旧 `CallRoute`(#88) への参照切れ検査は撤去した (#421 / 移行台帳 §5「取次モデル」)。
  // 参照元の `callRouteId` 自体を廃止したため、検査する対象が無い。
  // **上の 2 つ（取次契約の破れ / 有効ポリシーゼロ）は現行モデルの検査なので残す。**

  return findings;
}
