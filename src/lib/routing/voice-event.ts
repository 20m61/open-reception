/**
 * 通話ステータス webhook の適用 (issue #4 Inc D-2)。
 *
 * 判断そのものは純関数 `@/domain/routing/webhook-advance` にあり、ここは
 * **保存済みポリシーの読み出しと相関の永続化**だけを持つ（route を薄く保つ）。
 *
 * ## 発信（dial）はまだ行わない
 *
 * 取次が「次の手を撃つべき」と判断した場合、実際に発信するには provider を選ぶ必要があり、
 * それは **#4 Inc D-2 の項目 2（`executeRoutedCall` の mock/vonage 分岐）**＝実送信が
 * 起こりうるようになる停止境界。ここでは**位置を進めずに通話状態だけ保存し、
 * 保留であることをログに出す**。
 *
 * 🔴 **位置を進めないのが要点。** 発信していないのに位置だけ進めると、
 * 「撃ったことになっている手が実際には鳴っていない」不整合になる。撃てないなら動かさない。
 */
import { eventBudgetOf, withEventBudget } from '@/domain/routing/hop-event-budget';
import { advanceFromWebhook, type CallProgress } from '@/domain/routing/webhook-advance';
import type { VoiceCallEvent } from '@/domain/call/voice-call-state';
import type { RoutingPolicy } from '@/domain/routing/policy';
import { getCallCorrelationRepository, type StoredCallCorrelation } from './call-correlation';
import { asTenantId } from '@/domain/tenant/types';
import { getRoutingRepositories } from './store';

/** 相関に保存されたスコープのポリシーを読む（`executeRoutedCall` と同じサイト絞り込み）。 */
async function policiesFor(correlation: StoredCallCorrelation): Promise<RoutingPolicy[]> {
  const repos = getRoutingRepositories();
  const all = await repos.policies.list(asTenantId(correlation.tenantId));
  return all.filter((p) => p.siteId === undefined || p.siteId === correlation.siteId);
}

/**
 * 1 件の通話イベントを相関へ適用する。保存が起きたかを返す（テスト・ログ用）。
 *
 * `providerEventId` には webhook の `jti` を渡すこと。at-least-once 配信の二重処理で
 * 取次が余計に 1 手進むのを防ぐ冪等キーになる。
 */
export async function applyVoiceEventToCorrelation(
  correlation: StoredCallCorrelation,
  event: VoiceCallEvent,
  providerEventId: string,
): Promise<void> {
  const progress: CallProgress = {
    position: correlation.position,
    // 旧レコード（voiceState 導入前）は 'queued' 扱い。TTL 6 時間ですぐ入れ替わる。
    voiceState: correlation.voiceState ?? 'queued',
    settled: correlation.status === 'settled',
    // 🔴 **取次全体で数える (#646)。** position に載っていればそれを使う。相関側の値は
    // position を持たない旧レコードのための退避先（TTL 6 時間で入れ替わる）。
    // ここを相関側だけから読むと、2 手目の新レコードで 0 にリセットされ上限が緩む。
    eventCount: eventBudgetOf(correlation.position, correlation.eventCount),
  };

  const advance = advanceFromWebhook(progress, event, providerEventId, await policiesFor(correlation));

  // 無視（確定済み・重複配信・上限超過）では**保存しない**。
  // 重複で保存すると位置が余計に進み、上限超過で保存すると弾いた意味が無い（書き込みが資源消費）。
  if (advance.kind === 'ignored') {
    if (advance.reason === 'rate_limited') {
      console.warn(
        JSON.stringify({ event: 'vonage_webhook_rate_limited', providerCallId: correlation.providerCallId }),
      );
    }
    return;
  }

  if (advance.kind === 'dial') {
    // 発信できないので位置は動かさず、通話状態だけ記録する（上記 doc 参照）。
    console.info(
      JSON.stringify({
        event: 'vonage_routing_dial_pending',
        stepId: advance.step.id,
        reason: 'initiator_not_wired',
      }),
    );
  }

  const next =
    advance.kind === 'dial'
      ? {
          ...progress,
          // 位置（stepId / hops）は進めない ── 撃っていない手を撃ったことにしない。
          // 🔴 ただし **ledger は残す**（#645）。ledger は `advance.next.position` に載って
          // いるので、position ごと捨てると `jti` 冪等キーが永久に保存されず、
          // at-least-once の再配信で**同じ手の dial 判断が何度でも出る**。
          // 実発信を配線した経路ではそれが同一担当者への二重発信になる。
          position: { ...progress.position, ledger: advance.next.position.ledger },
          voiceState: advance.next.voiceState,
          eventCount: advance.next.eventCount,
        }
      : advance.next;

  await getCallCorrelationRepository().put({
    ...correlation,
    // イベント数も position へ書き戻す —— 2 手目の相関はこの position を引き継ぐので、
    // ここで載せておかないと次の手で 0 から数え直しになる (#646)。
    position: withEventBudget(next.position, next.eventCount),
    voiceState: next.voiceState,
    eventCount: next.eventCount,
    status: next.settled ? 'settled' : 'in_flight',
    updatedAt: new Date().toISOString(),
  });
}
