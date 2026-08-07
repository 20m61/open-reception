/**
 * 保存済みルーティングポリシーに従った取次の**実行時配線**（サーバ側） (issue #374 残 increment)。
 *
 * これまで `/api/kiosk/receptions/:id/call` は単発の Mock 呼び出し（担当者 1 名へ 1 回）だった。
 * 本モジュールは、テナント/サイトに**保存済みのルート**があれば、そのルート定義（順次取次・
 * 結果別遷移・fallback）を Orchestrator で段階実行し、応答へ `stages[]` を供給する。
 *
 * 方針:
 *   - **経路は 2 つある** (#4 Inc D-2 項目 2)。テナント設定が vonage + 資格情報完備なら
 *     `runVoiceRoutedCall`（**実 PSTN 発信**。1 手撃って `'calling'` を返し、続きは webhook）。
 *     それ以外は `createKioskMockProvider`（notify=応答なし / bridge=応答）で段階を決定的に
 *     再現する同期経路。**既定は mock**で、資格情報が 1 つでも欠ければ mock へ倒れる。
 *   - **後方互換**: ルート未設定なら `null` を返し、呼び出し側は従来の単発 Mock へ fail-open する。
 *   - **冪等**: Orchestrator の冪等台帳（`./ledger` 経由）をそのまま通すため、Provider の重複
 *     イベント（webhook 再配信 / retry）で二重発信しない（`runRoutedCall` の統合テストで固定）。
 *   - **PII 最小化**: 応答・stages にアドレス（e164/uri）や氏名を載せない。stages の key は
 *     手順 id（英数字/._- のみ）に限り、`parseCallStages` の契約でさらに濾す。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { CallAdapter, CallResult, CallResultStatus } from '@/adapters/call/types';
import { parseCallStages, type CallStage } from '@/domain/kiosk/call-stages';
import { endpointRef } from '@/domain/routing/endpoint';
import type { ConnectCommand, ConnectionProvider, ProviderConnectResult } from '@/domain/routing/provider';
import { runRouting, type RoutingOutcome } from '@/domain/routing/orchestrator';
import type { RouteResult } from '@/domain/routing/policy';
import { startRouting } from '@/domain/routing/resumable';
import type { VoiceCallInitiator } from '@/domain/routing/voice-initiator';
import { getCallCorrelationRepository, type StoredCallCorrelation } from './call-correlation';
import { getRoutingRepositories } from './store';
import { resolveVoiceInitiator } from './voice-dial';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

/** notify/announce 用の定型読み上げ文（PII を含めない）。 */
const KIOSK_ANNOUNCE_TEXT = '受付からの取次です。';

export type RoutedCallResult = {
  /**
   * 受付状態機械へ渡す取次結果。
   *
   * mock 経路は同期で確定するので `'calling'` を返さない。**実発信経路は必ず `'calling'`**
   * （1 手目を撃った時点では結果が無く、応答・未応答は webhook で後から届く）。
   */
  status: CallResultStatus;
  /** failed/timeout 時の理由（**非機微の固定コードのみ**。番号・資格情報を載せない）。 */
  reason?: string;
  /** 取次段階（#363 injection point 4）。実行トレースから供給する。 */
  stages: CallStage[];
  /** 実行結果（トレース等。非機微のみ）。**mock 同期経路のみ**。 */
  outcome?: RoutingOutcome;
  /** provider 側の通話 ID（相関キー）。**実発信経路のみ**。 */
  providerCallId?: string;
};

/** mock 同期経路の結果。`outcome` が必ず在り、`'calling'` は返らない。 */
export type MockRoutedCallResult = RoutedCallResult & {
  status: Exclude<CallResultStatus, 'calling'>;
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
): Promise<MockRoutedCallResult | null> {
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
 * 実発信経路の失敗理由。**固定コードのみ**（provider のエラーメッセージを載せると
 * 電話番号や URL が来訪者向け応答・ログへ漏れる）。
 */
type VoiceDialFailure =
  | 'no_entry_step'
  | 'endpoint_unavailable'
  | 'dial_failed'
  | 'correlation_write_failed';

export type VoiceRoutedCallDeps = {
  scope: { tenantId: string; siteId: string };
  policies: ReadonlyArray<StoredRoutingPolicy>;
  endpoints: ReadonlyArray<StoredContactEndpoint>;
  /** 実 PSTN 発信者（`resolveVoiceInitiator` の解決結果）。 */
  initiator: VoiceCallInitiator;
  saveCorrelation: (correlation: StoredCallCorrelation) => Promise<void>;
  now?: () => Date;
};

/** 実発信経路の段階表示。撃った 1 手は `active`（`done` ではない ── まだ結果が無い）。 */
function voiceStages(
  entry: Pick<StoredRoutingPolicy, 'steps'>,
  activeStepId?: string,
): CallStage[] {
  return parseCallStages({
    stages: entry.steps.map((s) => ({
      key: s.id,
      status: s.id === activeStepId ? 'active' : 'pending',
    })),
  });
}

/**
 * 保存済みルートの**最初の 1 手だけ**を実 PSTN で発信する (#4 Inc D-2 項目 2)。
 *
 * ## mock 経路と形が違う
 *
 * `runRoutedCall`（mock）は 1 リクエストの中で取次を最後まで回して確定するが、実 PSTN では
 * `POST /v1/calls` が返すのは「受け付けた」と通話 ID だけ。応答・DTMF・切断は webhook で
 * 後から届く。よってここは **1 手撃って `'calling'` で返す**のが正しい終わり方で、
 * 続きは `applyVoiceEventToCorrelation` が進める。
 *
 * ## 失敗を握り潰さない
 *
 * 🔴 **例外を投げない。** 呼び出し元（call route）は `executeRoutedCall` の例外を捕まえて
 * 単発 mock へ fail-open するので、ここで投げると**鳴っていないのに「繋がった」と
 * 来訪者へ表示しうる**。実発信経路の失敗は `failed` として返し、有人支援へ倒す。
 */
export async function runVoiceRoutedCall(
  callUuid: string,
  deps: VoiceRoutedCallDeps,
): Promise<RoutedCallResult | null> {
  const entry = selectEntryPolicy(deps.policies);
  if (entry === undefined) return null;

  const failed = (reason: VoiceDialFailure, activeStepId?: string): RoutedCallResult => {
    console.error(JSON.stringify({ event: 'voice_dial_failed', reason, policyId: entry.id }));
    return { status: 'failed', reason, stages: voiceStages(entry, activeStepId) };
  };

  const start = startRouting(deps.policies, entry.id, callUuid);
  if (start.kind !== 'dial') return failed('no_entry_step');

  // 接続先が引けない／無効なら撃たない。握り潰して撃つと誤った宛先へ繋がる余地が出る。
  const contact = deps.endpoints.find((e) => e.id === start.step.endpointId);
  if (contact === undefined || !contact.enabled) return failed('endpoint_unavailable');

  let providerCallId: string;
  try {
    const initiation = await deps.initiator.initiate({
      callUuid,
      endpoint: endpointRef(contact),
      action: start.step.action,
      timeoutSeconds: start.step.timeoutSeconds,
      announceText: KIOSK_ANNOUNCE_TEXT,
    });
    providerCallId = initiation.providerCallId;
  } catch {
    // 例外の中身は載せない（宛先・URL・資格情報が混ざりうる）。診断はサーバログ側で行う。
    return failed('dial_failed', start.step.id);
  }

  // 🔴 相関は**発信の後**にしか書けない（鍵になる provider 通話 ID は発信して初めて分かる）。
  // answer webhook 側が短時間リトライすることでこの順序逆転を吸収する（Inc D の設計判断）。
  try {
    await deps.saveCorrelation({
      providerCallId,
      receptionId: callUuid,
      tenantId: deps.scope.tenantId,
      siteId: deps.scope.siteId,
      position: start.position,
      voiceState: 'queued',
      eventCount: 0,
      status: 'in_flight',
      updatedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    // 相関が無いと 4 webhook とも 403 になり取次は永久に進まない。'calling' で返すと
    // 来訪者が無限に待つので、失敗として返して有人支援へ倒す（電話は 1 回鳴って切れる）。
    return failed('correlation_write_failed', start.step.id);
  }

  return {
    status: 'calling',
    stages: voiceStages(entry, start.step.id),
    providerCallId,
  };
}

/**
 * スコープ（テナント/サイト）に保存されたルートを読み、`runRoutedCall` を実行する。
 * ルート未設定なら `null`（fail-open）。永続化は admin 側と同じ backing collection / seed を共有。
 */
export type ExecuteRoutedCallOptions = {
  /**
   * webhook の基底 URL（**CloudFront のドメイン**。`resolveWebhookBaseUrl` で解決する）。
   *
   * 🔴 **未指定なら実発信しない。** Vonage へ渡すコールバック URL が Function URL になると
   * `x-origin-verify` が付かず全 webhook が 403 になり、鳴らしたのに一切進まない通話が残る
   * （#612 で実際に起きた事故と同型）。分からないなら撃たない。
   */
  webhookBaseUrl?: string;
  /** テスト用の差し替え。既定は `resolveVoiceInitiator`（テナント設定から解決）。 */
  resolveInitiator?: (
    tenantId: string,
    webhookBaseUrl: string,
  ) => Promise<VoiceCallInitiator | null>;
};

/**
 * スコープ（テナント/サイト）に保存されたルートを読み、mock / 実 PSTN のどちらかで実行する
 * (#4 Inc D-2 項目 2)。ルート未設定なら `null`（fail-open）。
 *
 * 実発信は次が**すべて**揃ったときだけ（1 つでも欠ければ mock ＝ fail-closed）:
 *   1. `webhookBaseUrl` が分かる
 *   2. テナント設定が vonage + enabled + secret 設定済み（`resolveProviderForTenant`）
 *   3. 発信用の資格情報が完備（`buildVoiceCredentials`）
 */
export async function executeRoutedCall(
  scope: { tenantId: TenantId; siteId: SiteId },
  callUuid: string,
  options: ExecuteRoutedCallOptions = {},
): Promise<RoutedCallResult | null> {
  const repos = getRoutingRepositories();
  const allPolicies = await repos.policies.list(scope.tenantId);
  // サイト scope: 同一サイト or テナント横断（siteId 未設定）のポリシーのみを対象にする。
  const policies = allPolicies.filter(
    (p) => p.siteId === undefined || p.siteId === String(scope.siteId),
  );
  const endpoints = await repos.endpoints.list(scope.tenantId);

  const resolveInitiator = options.resolveInitiator ?? resolveVoiceInitiator;
  const initiator = options.webhookBaseUrl
    ? await resolveInitiator(String(scope.tenantId), options.webhookBaseUrl)
    : null;

  if (initiator !== null) {
    return runVoiceRoutedCall(callUuid, {
      scope: { tenantId: String(scope.tenantId), siteId: String(scope.siteId) },
      policies,
      endpoints,
      initiator,
      saveCorrelation: (correlation) => getCallCorrelationRepository().put(correlation),
    });
  }

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
