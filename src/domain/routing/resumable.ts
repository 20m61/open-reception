/**
 * 再開可能な取次 (issue #4 MVP 1)。
 *
 * `./orchestrator.ts` は 1 リクエスト内でループを回し切る同期実行で、`connect()` がその場で
 * 最終結果を返す mock を前提にしている。**実 PSTN ではこれが成立しない** ── 1 手あたり
 * 呼出 20〜30 秒、しかも結果は webhook で後から届く。受付端末の HTTP リクエストを
 * その間ずっと掴んでいるわけにはいかない。
 *
 * そこでループを 2 つに割る:
 *
 *   startRouting()   → 「最初にどこへ発信するか」＋ 保存すべき位置
 *   advanceRouting() → 「この結果を受けて次にどこへ発信するか」＋ 新しい位置
 *
 * 間の位置（`RoutingPosition`）を永続化すれば、webhook が届くたびに 1 歩ずつ進められる。
 * 位置は **JSON でそのまま往復できる形**に保つ（DynamoDB へ載せるため。`Set` を使わない）。
 *
 * 純関数。Provider も HTTP も知らない ── 実際の発信は呼び出し側（adapter）が行う。
 */
import { idempotencyKey } from './ledger';
import { isTerminalSuccess, nextTransition, type RouteResult, type RoutingPolicy, type RoutingStep } from './policy';

/**
 * 取次のハング防止上限。
 *
 * **`orchestrator.ts` の既定（16）とは別**。あちらは同期実行 1 回で撃ち切る前提だが、
 * こちらは webhook 1 件で 1 手なので、暴走したときに鳴り続ける電話の本数がそのまま
 * 上限になる。担当者・代理・部門代表・総合受付を想定して 10 に置く。
 * **どちらかに寄せるなら値ではなく実装を統合すること**（値だけ揃えると二重の真実が残る）。
 */
export const DEFAULT_MAX_HOPS = 10;

/**
 * 取次の現在位置。**これだけを保存すれば再開できる。**
 * `ledger` は `Set` ではなく配列 ── JSON 往復で壊れないため（永続化前提）。
 */
export type RoutingPosition = {
  readonly callUuid: string;
  readonly policyId: string;
  readonly stepId: string;
  /** 撃った手の数。上限判定に使う。 */
  readonly hops: number;
  /** 処理済みイベントキー（`idempotencyKey` の値）。重複配信の判定に使う。 */
  readonly ledger: readonly string[];
};

export type RoutingAdvance =
  /** 次の 1 手を発信する。呼び出し側は position を保存してから発信すること。 */
  | { readonly kind: 'dial'; readonly position: RoutingPosition; readonly step: RoutingStep }
  /** 取次が確定した。これ以上発信しない。 */
  | { readonly kind: 'settled'; readonly result?: RouteResult; readonly reason: SettleReason }
  /** 重複配信。**position を保存し直さないこと**（保存すると取次が余計に 1 手進む）。 */
  | { readonly kind: 'duplicate' };

export type SettleReason =
  | 'no_entry_policy'
  | 'stopped'
  | 'dangling_step'
  | 'max_hops_exceeded'
  | 'no_fallback_policy';

export type AdvanceOptions = { readonly maxHops?: number };

function findPolicy(
  policies: ReadonlyArray<RoutingPolicy>,
  policyId: string,
): RoutingPolicy | undefined {
  return policies.find((p) => p.id === policyId);
}

function dialAt(
  policy: RoutingPolicy,
  stepIndex: number,
  base: Omit<RoutingPosition, 'policyId' | 'stepId'>,
): RoutingAdvance {
  const step = policy.steps[stepIndex];
  if (step === undefined) return { kind: 'settled', reason: 'dangling_step' };
  return {
    kind: 'dial',
    step,
    position: { ...base, policyId: policy.id, stepId: step.id },
  };
}

/** 取次を開始する。最初に発信すべき 1 手と、保存すべき位置を返す。 */
export function startRouting(
  policies: ReadonlyArray<RoutingPolicy>,
  entryPolicyId: string,
  callUuid: string,
): RoutingAdvance {
  const policy = findPolicy(policies, entryPolicyId);
  if (policy === undefined) return { kind: 'settled', reason: 'no_entry_policy' };
  return dialAt(policy, 0, { callUuid, hops: 0, ledger: [] });
}

/**
 * 1 手ぶんの結果を受けて次を決める。
 *
 * **重複配信は `duplicate` を返して何もしない。** ここを進めてしまうと、Vonage の
 * at-least-once 配信で取次が余計に 1 手進み、**担当者が応答していないのに次の人
 * （部門代表等）へ勝手に発信される**。
 */
export function advanceRouting(
  position: RoutingPosition,
  policies: ReadonlyArray<RoutingPolicy>,
  result: RouteResult,
  providerEventId: string,
  options: AdvanceOptions = {},
): RoutingAdvance {
  const key = idempotencyKey(position.callUuid, providerEventId);
  if (position.ledger.includes(key)) return { kind: 'duplicate' };

  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const hops = position.hops + 1;
  const ledger = [...position.ledger, key];
  const base = { callUuid: position.callUuid, hops, ledger };

  // 繋がったら止める。以降の手は撃たない。
  if (isTerminalSuccess(result)) return { kind: 'settled', result, reason: 'stopped' };

  const policy = findPolicy(policies, position.policyId);
  if (policy === undefined) return { kind: 'settled', result, reason: 'no_entry_policy' };
  const stepIndex = policy.steps.findIndex((s) => s.id === position.stepId);
  if (stepIndex < 0) return { kind: 'settled', result, reason: 'dangling_step' };

  // 上限は「ハングしない」ことの最後の砦。次の手を撃つ前に見る。
  if (hops >= maxHops) return { kind: 'settled', result, reason: 'max_hops_exceeded' };

  const transition = nextTransition(policy, stepIndex, result);
  if (transition.kind === 'stop') return { kind: 'settled', result, reason: 'stopped' };

  if (transition.kind === 'goto_step') {
    // 見つからなければ findIndex は -1 を返し、`dialAt` が `steps[-1]`（undefined）を
    // dangling として確定させる。ここで重ねて判定しない（死んだ分岐になる）。
    return dialAt(policy, policy.steps.findIndex((s) => s.id === transition.stepId), base);
  }

  const fallback = findPolicy(policies, transition.policyId);
  if (fallback === undefined) return { kind: 'settled', result, reason: 'no_fallback_policy' };
  return dialAt(fallback, 0, base);
}
