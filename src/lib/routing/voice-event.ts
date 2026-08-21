/**
 * 通話ステータス webhook の適用 (issue #4 Inc D-2)。
 *
 * 判断そのものは純関数 `@/domain/routing/webhook-advance` にあり、ここは
 * **保存済みポリシーの読み出しと相関の永続化**だけを持つ（route を薄く保つ）。
 *
 * ## 発信（dial）はここから配線されている (#646)
 *
 * 取次が「次の手を撃つべき」と判断したら `dialNextHop`（`./next-hop-dial.ts`）へ渡す。
 * 実発信が起こるのは 1 手目と**同じ条件が全部揃ったときだけ**で、1 つでも欠ければ撃たない:
 *
 *   1. `webhookBaseUrl` が分かる（CloudFront のドメイン。Function URL だと全 webhook が 403）
 *   2. `resolveVoiceInitiator` が発信者を返す（停止スイッチ `VOICE_DIALING_DISABLED` と
 *      テナント設定・資格情報の検査はこの中。**止めていれば null＝撃たない**）
 *   3. 次の手の接続先が有効
 *
 * 🔴 **撃てないときは位置を進めない。** 発信していないのに位置だけ進めると、
 * 「撃ったことになっている手が実際には鳴っていない」不整合になる。撃てないなら動かさない。
 *
 * 🔴 **撃てたときは逆に、ここで保存してはいけない。** 保存は `dialNextHop` の仕事
 * （1 手目の確定・2 手目の作成・受付の付け替えが 1 つの順序を成す）。ここで重ねて書くと
 * 「1 手目＝確定済み」を `in_flight` で潰し、遅れて届く webhook がまた 2 手目を撃つ。
 */
import { eventBudgetOf, withEventBudget } from '@/domain/routing/hop-event-budget';
import type { VoiceCallInitiator } from '@/domain/routing/voice-initiator';
import { getReception, repointProviderCall } from '@/lib/data-stores/reception-store';
import { dialNextHop as defaultDialNextHop } from './next-hop-dial';
import { resolveVoiceInitiator } from './voice-dial';
import type { StoredContactEndpoint } from './types';
import { advanceFromWebhook, type CallProgress } from '@/domain/routing/webhook-advance';
import type { VoiceCallEvent } from '@/domain/call/voice-call-state';
import type { RoutingPolicy, RoutingStep } from '@/domain/routing/policy';
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
export type VoiceEventDeps = {
  /**
   * Vonage へ渡すコールバックの基底 URL（**CloudFront のドメイン**）。
   * **未指定なら実発信しない** ── 1 手目（`ExecuteRoutedCallOptions.webhookBaseUrl`）と同じ規則。
   */
  readonly webhookBaseUrl?: string;
  readonly resolveInitiator?: (
    tenantId: string,
    webhookBaseUrl: string,
  ) => Promise<VoiceCallInitiator | null>;
  readonly listEndpoints?: (tenantId: string) => Promise<ReadonlyArray<StoredContactEndpoint>>;
  readonly repointReception?: (receptionId: string, providerCallId: string) => Promise<void>;
  readonly receptionState?: (receptionId: string) => Promise<string | undefined>;
  readonly dialNextHop?: typeof defaultDialNextHop;
  readonly now?: () => Date;
};

export async function applyVoiceEventToCorrelation(
  correlation: StoredCallCorrelation,
  event: VoiceCallEvent,
  providerEventId: string,
  deps: VoiceEventDeps = {},
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
    const dialed = await tryDialNextHop(correlation, advance.next, advance.step, deps);
    // 撃てた（または撃ったが記録が途中で途切れた）なら保存は発信側が済ませている。
    // ここで重ねて書くと 1 手目の確定を潰す（上記 doc 参照）。
    if (dialed === 'handled') return;
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

  // 🔴 **無条件 `put` にしない。** `/choice`（担当者の承諾）と `/events`（通話終了）は
  // 別の webhook として**並行**に届きうる。全体置換で書くと、後から書いた側が先に書かれた
  // 確定を潰す ── 担当者が「まもなく向かう」を押した直後に切ると、`/events` 側が先に
  // 次の手を撃ってしまい、`/choice` の書き戻しではもう受付が 2 手目を指している
  // （担当者 A が向かっているのに担当者 B の電話が鳴る）。
  //
  // 読んだ時点から動いていないときだけ書く。負けたら**何もしない**（勝った側の判断が正）。
  const saved = await getCallCorrelationRepository().updateIfUnchanged(
    correlation.providerCallId,
    {
      // イベント数も position へ書き戻す —— 2 手目の相関はこの position を引き継ぐので、
      // ここで載せておかないと次の手で 0 から数え直しになる (#646)。
      position: withEventBudget(next.position, next.eventCount),
      voiceState: next.voiceState,
      eventCount: next.eventCount,
      status: next.settled ? 'settled' : 'in_flight',
      updatedAt: new Date().toISOString(),
    },
    correlation.updatedAt,
  );
  if (!saved) {
    // 勝敗を無音にしない。ここが無いと「押したのに次が鳴った」の切り分けができない。
    console.warn(
      JSON.stringify({
        event: 'vonage_webhook_apply_lost_race',
        providerCallId: correlation.providerCallId,
      }),
    );
  }
}

/**
 * 次の手を撃つ。**保存まで発信側が済ませたか**を返す（`'handled'`）。
 *
 * 撃てなかった場合は `'not_dialed'` を返し、呼び出し側が従来どおり
 * 「位置は進めず、台帳と通話状態だけ保存」する。
 */
async function tryDialNextHop(
  correlation: StoredCallCorrelation,
  next: CallProgress,
  step: RoutingStep,
  deps: VoiceEventDeps,
): Promise<'handled' | 'not_dialed'> {
  const dial = deps.dialNextHop ?? defaultDialNextHop;
  const resolveInitiator = deps.resolveInitiator ?? resolveVoiceInitiator;
  // 🔴 基底 URL が分からないなら**解決すらしない**（secret も読ませない）。
  const initiator = deps.webhookBaseUrl
    ? await resolveInitiator(correlation.tenantId, deps.webhookBaseUrl)
    : null;

  if (initiator === null) {
    console.info(
      JSON.stringify({
        event: 'vonage_routing_dial_skipped',
        stepId: step.id,
        reason: deps.webhookBaseUrl ? 'initiator_unavailable' : 'webhook_base_url_unknown',
      }),
    );
    return 'not_dialed';
  }

  const listEndpoints =
    deps.listEndpoints ??
    ((tenantId: string) => getRoutingRepositories().endpoints.list(asTenantId(tenantId)));
  const repointReception =
    deps.repointReception ??
    (async (receptionId: string, providerCallId: string) => {
      const result = await repointProviderCall(receptionId, providerCallId);
      // 書けなかったことを黙って飲まない ── `/status` が 1 手目を読み続ける。
      if (!result.ok) throw new Error(result.error.code);
    });

  const receptionState =
    deps.receptionState ??
    (async (receptionId: string) => {
      const found = await getReception(receptionId);
      // 読めなければ `undefined`。**不在から「まだ呼び出し中だ」をでっち上げない**
      // （判断は `decideRoutingStop` が持つ）。
      return found.ok ? found.value.state : undefined;
    });

  const result = await dial({
    correlation,
    next,
    step,
    endpoints: await listEndpoints(correlation.tenantId),
    initiator,
    saveCorrelation: (c) => getCallCorrelationRepository().put(c),
    updateIfUnchanged: (id, changes, expectedUpdatedAt) =>
      getCallCorrelationRepository().updateIfUnchanged(id, changes, expectedUpdatedAt),
    repointReception,
    receptionState,
    now: deps.now,
  });

  // 撃った／撃たなかったを**理由込みで**残す。一様な 200 応答の対価がこれで、無いと
  // 「担当者の電話が鳴らない」通報に対して段を切り分ける手段が消える。値・番号は載せない。
  console.info(
    JSON.stringify({ event: 'vonage_routing_next_hop', stepId: step.id, result: result.kind }),
  );

  // 8 種の戻り値を 2 つに畳む。分け方の根拠は「**誰かが既に書いたか**」:
  //
  //   not_dialed（呼び出し側が保存する）
  //     not_wired / endpoint_unavailable / reception_closed / reserve_failed
  //     ── いずれも撃っておらず、相関にも何も書いていない。**保存させるのが大事**で、
  //        保存しないとイベント上限が進まず、公開エンドポイントから何度でも同じ判断を
  //        踏ませられる（`reception_closed` も同じ理由でこちら側）。
  //
  //   handled（呼び出し側は触らない）
  //     dialed / handoff_incomplete / dial_failed ── 発信側が既に書いている。
  //     reserve_lost ── 別の配信が撃った。ここで保存すると**勝った側の確定を潰す**。
  return result.kind === 'not_wired' ||
    result.kind === 'endpoint_unavailable' ||
    result.kind === 'reception_closed' ||
    result.kind === 'reserve_failed'
    ? 'not_dialed'
    : 'handled';
}
