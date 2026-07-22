/**
 * ルーティング Orchestrator (issue #374)。
 *
 * RoutingPolicy を 1 手ずつ実行し、結果に応じて次遷移（次 step / fallback policy / 終了）を
 * 解決する。**Provider webhook とは分離**し、Provider 固有の状態機械に依存しない
 * （`ConnectionProvider` interface 越しにしか外部と話さない）。
 *
 * 無限取次の防止は二重に効かせる:
 *   1. 静的検出（`validateRoutingPolicySet` / `findAllFallbackCycleIds`）— 循環ポリシー集合を実行前に弾く。
 *   2. **実行時 hop 上限（`maxHops`）** — 検証を素通りした・goto の実行時ループでも必ず停止する
 *      最後の砦。上限に達したら `exhausted / max_hops_exceeded` で止める（決してハングしない）。
 *
 * 冪等境界: 1 通話 `callUuid` 内の Provider イベントを `providerEventId` で一意化し（`./ledger.ts`）、
 * 重複配信のイベントを二重処理しない。
 *
 * トレース・監査には**アドレス（e164/uri）を載せない**。載せるのは endpointId・ownerType・
 * action・結果・providerEventId といった非機微情報のみ（`.claude/rules/pii-secret-minimization.md`）。
 */
import type { ContactEndpoint, EndpointOwnerType } from './endpoint';
import { endpointRef } from './endpoint';
import { emptyLedger, recordProviderEvent, type ProviderEventLedger } from './ledger';
import {
  isTerminalSuccess,
  nextTransition,
  type RouteAction,
  type RouteResult,
  type RoutingPolicy,
} from './policy';
import type { ConnectionProvider } from './provider';

/** 取次 1 手の非機微トレース。アドレスは含めない。 */
export type RoutingTraceEntry = {
  policyId: string;
  stepId: string;
  endpointId: string;
  ownerType: EndpointOwnerType;
  action: RouteAction;
  result: RouteResult;
  providerEventId: string;
};

export type RoutingOutcomeStatus =
  /** 人へ繋がった（成功終端に到達）。 */
  | 'connected'
  /** 取次は完走したが誰にも繋がらなかった（stop に到達）。 */
  | 'unreached'
  /** hop 上限・重複イベント・構成不備で打ち切った。 */
  | 'exhausted';

export type RoutingOutcomeReason =
  | 'max_hops_exceeded'
  | 'duplicate_event'
  | 'no_entry_policy'
  | 'stopped'
  | 'dangling_step';

export type RoutingOutcome = {
  status: RoutingOutcomeStatus;
  /** connected 時は到達した成功結果。unreached/exhausted 時は最後に観測した結果（あれば）。 */
  result?: RouteResult;
  reason: RoutingOutcomeReason;
  trace: RoutingTraceEntry[];
  /** 実行した取次手数（hop）。 */
  hops: number;
  /** 処理済みイベント台帳（webhook 駆動へ引き継ぐ用）。 */
  ledger: ProviderEventLedger;
};

export type RunRoutingParams = {
  policies: ReadonlyArray<RoutingPolicy>;
  entryPolicyId: string;
  endpoints: ReadonlyArray<ContactEndpoint>;
  providers: ReadonlyArray<ConnectionProvider>;
  callUuid: string;
  /** 取次手数の上限。既定 16。循環・構成不備でも必ずこの手数で停止する。 */
  maxHops?: number;
  /** notify / announce_and_bridge 用の定型読み上げ文（PII 最小）。 */
  announceText?: string;
};

const DEFAULT_MAX_HOPS = 16;

/**
 * ローカル要因（Endpoint 欠落・無効・Provider 未登録）による 1 手失敗のイベント id。
 * Provider を呼ばずに `failed` として次遷移へ進むため、台帳とトレースに載せる合成 id を作る。
 */
function localFailureEventId(callUuid: string, hops: number): string {
  return `local:${callUuid}:${hops}`;
}

export async function runRouting(params: RunRoutingParams): Promise<RoutingOutcome> {
  const { policies, entryPolicyId, callUuid } = params;
  const maxHops = params.maxHops ?? DEFAULT_MAX_HOPS;

  const policyById = new Map(policies.map((p) => [p.id, p]));
  const endpointById = new Map(params.endpoints.map((e) => [e.id, e]));
  const providerByKey = new Map(params.providers.map((p) => [p.key, p]));

  let ledger: ProviderEventLedger = emptyLedger();
  const trace: RoutingTraceEntry[] = [];
  let hops = 0;
  let lastResult: RouteResult | undefined;

  let policy = policyById.get(entryPolicyId);
  if (policy === undefined) {
    return { status: 'unreached', reason: 'no_entry_policy', trace, hops, ledger };
  }
  let stepIndex = 0;

  // 上限は「ハングしない」ことの最後の砦。while(true) だが必ず return で抜ける。
  while (true) {
    if (hops >= maxHops) {
      return { status: 'exhausted', result: lastResult, reason: 'max_hops_exceeded', trace, hops, ledger };
    }

    const step = policy.steps[stepIndex];
    if (step === undefined) {
      // 遷移解決の不整合（goto 先が配列に無い等）。ハングさせず打ち切る。
      return { status: 'exhausted', result: lastResult, reason: 'dangling_step', trace, hops, ledger };
    }

    const endpoint = endpointById.get(step.endpointId);
    const provider =
      endpoint === undefined ? undefined : providerByKey.get(endpoint.providerKey);

    let result: RouteResult;
    let providerEventId: string;
    if (endpoint === undefined || !endpoint.enabled || provider === undefined) {
      // ローカル要因の失敗。Provider は呼ばない。
      result = 'failed';
      providerEventId = localFailureEventId(callUuid, hops);
    } else {
      const pr = await provider.connect({
        callUuid,
        endpoint: endpointRef(endpoint),
        action: step.action,
        timeoutSeconds: step.timeoutSeconds,
        announceText: params.announceText,
      });
      result = pr.result;
      providerEventId = pr.providerEventId;
    }

    hops += 1;

    // 冪等境界: 同一 (callUuid, providerEventId) を二重処理しない。正常な Provider は 1 手ごとに
    // 一意な id を返すので、重複＝webhook 再配信。二重に取次を進めないよう打ち切る。
    const recorded = recordProviderEvent(ledger, callUuid, providerEventId);
    if (recorded.duplicate) {
      return { status: 'exhausted', result: lastResult, reason: 'duplicate_event', trace, hops, ledger };
    }
    ledger = recorded.ledger;

    lastResult = result;
    trace.push({
      policyId: policy.id,
      stepId: step.id,
      endpointId: step.endpointId,
      ownerType: endpoint?.ownerType ?? 'system',
      action: step.action,
      result,
      providerEventId,
    });

    if (isTerminalSuccess(result)) {
      return { status: 'connected', result, reason: 'stopped', trace, hops, ledger };
    }

    const transition = nextTransition(policy, stepIndex, result);
    if (transition.kind === 'stop') {
      return { status: 'unreached', result: lastResult, reason: 'stopped', trace, hops, ledger };
    }
    if (transition.kind === 'goto_step') {
      const nextIndex = policy.steps.findIndex((s) => s.id === transition.stepId);
      if (nextIndex < 0) {
        return { status: 'exhausted', result: lastResult, reason: 'dangling_step', trace, hops, ledger };
      }
      stepIndex = nextIndex;
      continue;
    }
    // fallback_policy: 別ポリシーへ受け渡す。
    const nextPolicy = policyById.get(transition.policyId);
    if (nextPolicy === undefined) {
      return { status: 'exhausted', result: lastResult, reason: 'dangling_step', trace, hops, ledger };
    }
    policy = nextPolicy;
    stepIndex = 0;
  }
}
