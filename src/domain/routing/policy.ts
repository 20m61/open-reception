/**
 * ルーティングポリシー（順次取次）のドメイン型と検証 (issue #374)。
 *
 * 設計方針:
 *   - **優先順位は Endpoint ではなく RoutingPolicy の step 側**が持つ（steps 配列の順序 = 優先順位）。
 *   - step は「どの Endpoint へ・どの動作（notify/live_bridge/announce_and_bridge）で・
 *     何秒待つか・結果別にどこへ遷移するか（nextOn）」だけを宣言する。Endpoint は route を所有しない。
 *   - fallback route（別ポリシーへの受け渡し）を許すため、**循環検出と最大 hop 数**で
 *     無限取次を防ぐ（`findAllFallbackCycleIds` の静的検出 + Orchestrator の実行時 hop 上限）。
 *
 * すべて純関数。副作用（実際の接続・監査）は Orchestrator / service 層に閉じる。
 */

/**
 * 取次 1 手の結果。provider 非依存の受付ドメイン語彙に正規化する（Vonage 固有語を持ち込まない）。
 *   - answered: 相手が応答した（通話成立）。
 *   - accepted: 担当者が受付を引き受けた（アプリ内応答等）。
 *   - staff_coming: 「今行きます」等、来訪者対応が確定した。
 *   - busy: 話中。
 *   - no_answer: 呼び出したが応答なし（タイムアウト）。
 *   - declined: 明示的に拒否された。
 *   - failed: 接続そのものが失敗した（回線・provider エラー）。
 */
export const ROUTE_RESULTS = [
  'answered',
  'accepted',
  'staff_coming',
  'busy',
  'no_answer',
  'declined',
  'failed',
] as const;
export type RouteResult = (typeof ROUTE_RESULTS)[number];

/** 取次の目的が達成された（人へ繋がった）結果。ここに至ったら取次を止める。 */
export const TERMINAL_SUCCESS_RESULTS: readonly RouteResult[] = ['answered', 'accepted', 'staff_coming'];

/** まだ人へ繋がっていない（次の手へ進みうる）結果。 */
export const CONTINUABLE_RESULTS: readonly RouteResult[] = ['busy', 'no_answer', 'declined', 'failed'];

export function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === 'string' && (ROUTE_RESULTS as readonly string[]).includes(value);
}

/** 人へ繋がった（成功終端）か。 */
export function isTerminalSuccess(result: RouteResult): boolean {
  return TERMINAL_SUCCESS_RESULTS.includes(result);
}

/** step の動作種別。notify（通知のみ）と live_bridge（即通話）と announce_and_bridge（読み上げ後に通話）を分離する。 */
export const ROUTE_ACTIONS = ['notify', 'live_bridge', 'announce_and_bridge'] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export function isRouteAction(value: unknown): value is RouteAction {
  return typeof value === 'string' && (ROUTE_ACTIONS as readonly string[]).includes(value);
}

/**
 * 結果別の次遷移。nextOn で明示されなかった結果には既定遷移（`defaultTransition`）が使われる。
 *   - stop: 取次を終了する（これ以上呼ばない）。
 *   - goto_step: 同一ポリシー内の別 step へ跳ぶ（step.id 指定）。
 *   - fallback_policy: 別ポリシーへ受け渡す（fallback route）。循環検出・hop 上限の対象。
 */
export type RouteTransition =
  | { kind: 'stop' }
  | { kind: 'goto_step'; stepId: string }
  | { kind: 'fallback_policy'; policyId: string };

/** 取次 1 手（step）。優先順位は steps 配列の順序で表す。 */
export type RoutingStep = {
  /** ポリシー内で一意な step id（goto_step の宛先・トレース・循環判定に使う）。 */
  id: string;
  /** 接続先 Endpoint の id（`ContactEndpoint.id`）。 */
  endpointId: string;
  action: RouteAction;
  /** この手の応答待ち秒数（正の整数）。 */
  timeoutSeconds: number;
  /**
   * 結果別の遷移の上書き。未指定の結果は既定（成功=stop / 継続可能=次 step、無ければ
   * `fallbackPolicyId` があればそれ、無ければ stop）に従う。
   */
  nextOn: Partial<Record<RouteResult, RouteTransition>>;
};

/** ルーティングポリシー（1 本の取次ルート）。 */
export type RoutingPolicy = {
  id: string;
  tenantId: string;
  /** 対象サイト。未設定はテナント横断。境界認可は service 層で行う。 */
  siteId?: string;
  name: string;
  /** 取次手順。先頭から順に評価する（= 優先順位）。 */
  steps: RoutingStep[];
  /**
   * 全 step を撃ち尽くした後に受け渡す別ポリシー（route レベルの fallback）。
   * 未設定なら撃ち尽くし時点で取次終了。循環検出・hop 上限の対象。
   */
  fallbackPolicyId?: string;
  enabled: boolean;
};

/**
 * ある step がある結果を得たときの遷移を解決する（純関数）。
 * nextOn の明示 > 既定（成功=stop / 継続可能=次 step / 末尾なら fallbackPolicy or stop）。
 *
 * @param stepIndex policy.steps 内での step の位置。末尾判定に使う。
 */
export function nextTransition(
  policy: RoutingPolicy,
  stepIndex: number,
  result: RouteResult,
): RouteTransition {
  const step = policy.steps[stepIndex];
  if (step === undefined) return { kind: 'stop' };

  const explicit = step.nextOn[result];
  if (explicit !== undefined) return explicit;

  if (isTerminalSuccess(result)) return { kind: 'stop' };

  // 継続可能な結果の既定: 次の step があれば進む。
  const next = policy.steps[stepIndex + 1];
  if (next !== undefined) return { kind: 'goto_step', stepId: next.id };

  // 末尾まで来た: route レベル fallback があれば受け渡す、無ければ終了。
  if (policy.fallbackPolicyId !== undefined) {
    return { kind: 'fallback_policy', policyId: policy.fallbackPolicyId };
  }
  return { kind: 'stop' };
}

export type RoutingPolicyIssue =
  | { kind: 'empty_policy'; policyId: string }
  | { kind: 'duplicate_step_id'; policyId: string; stepId: string }
  | { kind: 'non_positive_timeout'; policyId: string; stepId: string }
  | { kind: 'unknown_endpoint'; policyId: string; stepId: string; endpointId: string }
  | { kind: 'unknown_goto_step'; policyId: string; stepId: string; targetStepId: string }
  | { kind: 'unknown_fallback_policy'; policyId: string; targetPolicyId: string }
  | { kind: 'fallback_cycle'; policyId: string };

/**
 * fallback route（ポリシー間の `fallbackPolicyId`）の**全**循環ノードを返す。
 *
 * 各ポリシーの fallbackPolicyId は高々 1 本（= functional graph）なので、
 * 組織階層（`domain/organization/hierarchy.ts`）と同じ「出次数 0 のノードから剥がす」
 * 走査で、最後に残るのが循環に属するポリシーちょうどになる。最初の 1 循環しか返さない
 * 素朴 DFS だと複数循環を取りこぼすため、全件返すこの実装を検証・Orchestrator が使う。
 */
export function findAllFallbackCycleIds(policies: ReadonlyArray<RoutingPolicy>): Set<string> {
  const byId = new Map<string, RoutingPolicy>();
  for (const p of policies) if (!byId.has(p.id)) byId.set(p.id, p);

  // 被参照数（自分を fallback 先に指しているポリシー数）。
  const inFallbackCount = new Map<string, number>();
  for (const id of byId.keys()) inFallbackCount.set(id, 0);
  for (const p of byId.values()) {
    const target = p.fallbackPolicyId;
    if (target === undefined || !byId.has(target)) continue;
    inFallbackCount.set(target, (inFallbackCount.get(target) ?? 0) + 1);
  }

  const remaining = new Set(byId.keys());
  const queue = [...remaining].filter((id) => (inFallbackCount.get(id) ?? 0) === 0);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || !remaining.has(id)) continue;
    remaining.delete(id);
    const target = byId.get(id)?.fallbackPolicyId;
    if (target === undefined || !remaining.has(target)) continue;
    const next = (inFallbackCount.get(target) ?? 0) - 1;
    inFallbackCount.set(target, next);
    if (next === 0) queue.push(target);
  }
  return remaining;
}

/**
 * ポリシー集合の構造的な問題を全件返す（空配列 = 妥当）。書き込み前検証・seed の健全性確認に使う。
 * 循環している間は取次が定義できないので `fallback_cycle` を報告する。
 *
 * @param endpointIds 参照可能な Endpoint id 集合。step.endpointId がこれに無ければ `unknown_endpoint`。
 */
export function validateRoutingPolicySet(
  policies: ReadonlyArray<RoutingPolicy>,
  endpointIds: ReadonlySet<string>,
): RoutingPolicyIssue[] {
  const issues: RoutingPolicyIssue[] = [];
  const policyIds = new Set(policies.map((p) => p.id));

  for (const policy of policies) {
    if (policy.steps.length === 0) {
      issues.push({ kind: 'empty_policy', policyId: policy.id });
    }

    const stepIds = new Set<string>();
    for (const step of policy.steps) {
      if (stepIds.has(step.id)) {
        issues.push({ kind: 'duplicate_step_id', policyId: policy.id, stepId: step.id });
      }
      stepIds.add(step.id);
    }

    for (const step of policy.steps) {
      if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds <= 0) {
        issues.push({ kind: 'non_positive_timeout', policyId: policy.id, stepId: step.id });
      }
      if (!endpointIds.has(step.endpointId)) {
        issues.push({
          kind: 'unknown_endpoint',
          policyId: policy.id,
          stepId: step.id,
          endpointId: step.endpointId,
        });
      }
      for (const transition of Object.values(step.nextOn)) {
        if (transition === undefined) continue;
        if (transition.kind === 'goto_step' && !stepIds.has(transition.stepId)) {
          issues.push({
            kind: 'unknown_goto_step',
            policyId: policy.id,
            stepId: step.id,
            targetStepId: transition.stepId,
          });
        }
        if (transition.kind === 'fallback_policy' && !policyIds.has(transition.policyId)) {
          issues.push({
            kind: 'unknown_fallback_policy',
            policyId: policy.id,
            targetPolicyId: transition.policyId,
          });
        }
      }
    }

    if (policy.fallbackPolicyId !== undefined && !policyIds.has(policy.fallbackPolicyId)) {
      issues.push({
        kind: 'unknown_fallback_policy',
        policyId: policy.id,
        targetPolicyId: policy.fallbackPolicyId,
      });
    }
  }

  const cycleIds = findAllFallbackCycleIds(policies);
  for (const id of cycleIds) issues.push({ kind: 'fallback_cycle', policyId: id });

  return issues;
}
