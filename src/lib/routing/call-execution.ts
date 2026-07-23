/**
 * 保存済みルーティングポリシーに従った取次の**実行時配線**（サーバ側） (issue #374 残 increment)。
 *
 * これまで `/api/kiosk/receptions/:id/call` は単発の Mock 呼び出し（担当者 1 名へ 1 回）だった。
 * 本モジュールは、テナント/サイトに**保存済みのルート**があれば、そのルート定義（順次取次・
 * 結果別遷移・fallback）を Orchestrator で段階実行し、応答へ `stages[]` を供給する。
 *
 * 方針:
 *   - **外部発信は mock provider のまま**（実 Vonage 発信は #4 の外部待ち）。ここでは
 *     `createKioskMockProvider`（notify=応答なし / bridge=応答）で決定的に段階を再現する。
 *   - **後方互換**: ルート未設定なら `null` を返し、呼び出し側は従来の単発 Mock へ fail-open する。
 *   - **冪等**: Orchestrator の冪等台帳（`./ledger` 経由）をそのまま通すため、Provider の重複
 *     イベント（webhook 再配信 / retry）で二重発信しない（`runRoutedCall` の統合テストで固定）。
 *   - **PII 最小化**: 応答・stages にアドレス（e164/uri）や氏名を載せない。stages の key は
 *     手順 id（英数字/._- のみ）に限り、`parseCallStages` の契約でさらに濾す。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { CallAdapter, CallResult, CallResultStatus } from '@/adapters/call/types';
import { parseCallStages, type CallStage } from '@/domain/kiosk/call-stages';
import type { ConnectCommand, ConnectionProvider, ProviderConnectResult } from '@/domain/routing/provider';
import { runRouting, type RoutingOutcome } from '@/domain/routing/orchestrator';
import type { RouteResult } from '@/domain/routing/policy';
import { getRoutingRepositories } from './store';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

/** notify/announce 用の定型読み上げ文（PII を含めない）。 */
const KIOSK_ANNOUNCE_TEXT = '受付からの取次です。';

export type RoutedCallResult = {
  /** 受付状態機械へ渡す取次結果（'calling' は返さない＝ mock は同期確定）。 */
  status: Exclude<CallResultStatus, 'calling'>;
  /** failed/timeout 時の理由（非機微）。 */
  reason?: string;
  /** 取次段階（#363 injection point 4）。実行トレースから供給する。 */
  stages: CallStage[];
  /** 実行結果（トレース等。非機微のみ）。テスト・監査補助用。 */
  outcome: RoutingOutcome;
};

/**
 * ルート集合から**実行の起点**となるポリシーを選ぶ。
 *   - 無効（enabled=false）は除外。有効が 1 つも無ければ undefined（呼び出し側は fail-open）。
 *   - 他ポリシーの fallback 先（＝葉）ではなく、どこからも参照されない root を優先する。
 *   - それでも決まらなければ先頭（安定した決定的選択）。
 */
export function selectEntryPolicy(
  policies: ReadonlyArray<StoredRoutingPolicy>,
): StoredRoutingPolicy | undefined {
  const enabled = policies.filter((p) => p.enabled);
  if (enabled.length === 0) return undefined;
  const referenced = new Set<string>();
  for (const p of enabled) {
    if (p.fallbackPolicyId !== undefined) referenced.add(p.fallbackPolicyId);
  }
  return enabled.find((p) => !referenced.has(p.id)) ?? enabled[0];
}

/**
 * kiosk 実行用の mock ConnectionProvider（**外部発信しない**）。
 *   - notify: 通知のみで応答は取らない → `no_answer`（次の手へ進む）。
 *   - live_bridge / announce_and_bridge: 担当者へ繋がる → `answered`。
 * これにより「個人携帯へ通知→…→部門代表へ読み上げてつなぐ」で最後に繋がる、といった
 * 段階が決定的に再現される。実 Provider（#4）へ差し替えても Orchestrator は無改変。
 *
 * プロバイダ選択の権威は `@/lib/platform/provider-resolution` の `resolveProviderForTenant(tenantId)`。
 * この経路は資格情報を一切読まない純 mock（グローバル `VONAGE_*` env にも依存しない）ため、#405 Inc3
 * では切替対象の env が無い。#4 で実 `VonageConnectionProvider` が入った時点で、`executeRoutedCall`
 * が `resolveProviderForTenant(scope.tenantId)` の解決結果に応じて mock / vonage を選ぶ（現状は mock）。
 */
export function createKioskMockProvider(key: string): ConnectionProvider {
  let n = 0;
  return {
    key,
    async connect(command: ConnectCommand): Promise<ProviderConnectResult> {
      const index = n;
      n += 1;
      const result: RouteResult = command.action === 'notify' ? 'no_answer' : 'answered';
      return { result, providerEventId: `mock:${command.callUuid}:${index}` };
    },
  };
}

/** endpoints が使う providerKey ごとに 1 つ mock provider を用意する。 */
function defaultProviders(endpoints: ReadonlyArray<StoredContactEndpoint>): ConnectionProvider[] {
  const keys = new Set(endpoints.map((e) => e.providerKey));
  return [...keys].map((k) => createKioskMockProvider(k));
}

/** Orchestrator の結果を受付状態機械の結果へ写像する（後方互換の応答契約）。 */
export function outcomeToCallStatus(outcome: RoutingOutcome): Exclude<CallResultStatus, 'calling'> {
  switch (outcome.status) {
    case 'connected':
      return 'connected';
    case 'unreached':
      // 全手を撃ち尽くしても人へ繋がらなかった＝未応答（タイムアウト相当）。
      return 'timeout';
    case 'exhausted':
      // hop 上限 / 重複イベント / 構成不備で打ち切り＝失敗。
      return 'failed';
  }
}

/**
 * entry policy の手順列 + 実行トレースから取次段階を作る。
 * 実行済み（トレースに現れた）手順は `done`、未到達は `pending`。key は手順 id。
 * `parseCallStages` の契約（英数字/._- のみ・最大 8 段）でさらに濾す（表示暴走・PII 混入防止）。
 */
export function buildCallStages(
  entry: Pick<StoredRoutingPolicy, 'id' | 'steps'>,
  trace: RoutingOutcome['trace'],
): CallStage[] {
  const executed = new Set(trace.filter((t) => t.policyId === entry.id).map((t) => t.stepId));
  const raw = entry.steps.map((s) => ({ key: s.id, status: executed.has(s.id) ? 'done' : 'pending' }));
  return parseCallStages({ stages: raw });
}

export type RunRoutedCallDeps = {
  policies: ReadonlyArray<StoredRoutingPolicy>;
  endpoints: ReadonlyArray<StoredContactEndpoint>;
  /** 差し替え可能な Provider（既定は kiosk mock）。テストで冪等境界などを固定する。 */
  providers?: ReadonlyArray<ConnectionProvider>;
  maxHops?: number;
};

/**
 * 保存済みルートに従って取次を段階実行する。有効ルートが無ければ `null`（呼び出し側は
 * 従来の単発 Mock へ fail-open）。
 */
export async function runRoutedCall(
  callUuid: string,
  deps: RunRoutedCallDeps,
): Promise<RoutedCallResult | null> {
  const entry = selectEntryPolicy(deps.policies);
  if (entry === undefined) return null;

  const outcome = await runRouting({
    policies: deps.policies,
    entryPolicyId: entry.id,
    endpoints: deps.endpoints,
    providers: deps.providers ?? defaultProviders(deps.endpoints),
    callUuid,
    maxHops: deps.maxHops,
    announceText: KIOSK_ANNOUNCE_TEXT,
  });

  return {
    status: outcomeToCallStatus(outcome),
    reason: outcome.status === 'connected' ? undefined : outcome.reason,
    stages: buildCallStages(entry, outcome.trace),
    outcome,
  };
}

/**
 * スコープ（テナント/サイト）に保存されたルートを読み、`runRoutedCall` を実行する。
 * ルート未設定なら `null`（fail-open）。永続化は admin 側と同じ backing collection / seed を共有。
 */
export async function executeRoutedCall(
  scope: { tenantId: TenantId; siteId: SiteId },
  callUuid: string,
): Promise<RoutedCallResult | null> {
  const repos = getRoutingRepositories();
  const allPolicies = await repos.policies.list(scope.tenantId);
  // サイト scope: 同一サイト or テナント横断（siteId 未設定）のポリシーのみを対象にする。
  const policies = allPolicies.filter(
    (p) => p.siteId === undefined || p.siteId === String(scope.siteId),
  );
  const endpoints = await repos.endpoints.list(scope.tenantId);
  return runRoutedCall(callUuid, { policies, endpoints });
}

/** `RoutedCallResult` を `startCall` に渡す同期 CallAdapter へ包む（状態機械はそのまま駆動）。 */
export function routedCallAdapter(routed: RoutedCallResult): CallAdapter {
  return {
    async call(): Promise<CallResult> {
      return { status: routed.status, reason: routed.reason };
    },
  };
}
