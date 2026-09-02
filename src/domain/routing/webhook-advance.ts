/**
 * webhook 1 件で取次を 1 歩進める判断 (issue #4 Inc D-2)。
 *
 * `./resumable.ts`（取次の位置）と `@/domain/call/voice-call-state`（通話の状態）は
 * どちらも純関数として在ったが、**繋ぐ者が居なかった**。Inc D-1 時点の
 * `/api/providers/vonage/events` は次のように書かれていた:
 *
 * ```ts
 * const next = applyVoiceEvent('queued', { kind: 'status', status });
 * const result = voiceStateToRouteResult(next);
 * void result;   // ← 捨てる
 * ```
 *
 * 保存済みの状態を読まず**毎回 `'queued'` から畳み直して結果を捨てていた**。
 * 「動いているように見えて何もしていない」状態で、これを配線するのがここ。
 *
 * ## なぜ保存状態から畳まないといけないか
 *
 * `applyVoiceEvent` は terminal 状態を short-circuit することで「巻き戻さない」性質を
 * 担保している。毎回 `'queued'` から畳むとその保護が丸ごと消える。
 *
 * 実害: 担当者が DTMF で応答して `'answered'`（terminal）になった後、通話終了の
 * `completed` が届くと、`'queued'` からの畳み直しでは **`no_answer`** になり、
 * **応答済みなのに次の人（代理・部門代表）へ発信する**。
 *
 * ## 確定後は進めない
 *
 * 確定（settled）した相関に遅れて届いたイベントで取次を再開しない。担当者が向かって
 * いるのに部門代表まで鳴る、という事故を防ぐ。
 *
 * 純関数。Provider も HTTP も永続化も知らない ── 保存と発信は呼び出し側が行う。
 */
import {
  applyVoiceEvent,
  voiceStateToRouteResult,
  type VoiceCallEvent,
  type VoiceCallState,
} from '@/domain/call/voice-call-state';
import type { RouteResult, RoutingPolicy, RoutingStep } from './policy';
import {
  advanceRouting,
  type AdvanceOptions,
  type RoutingPosition,
  type SettleReason,
} from './resumable';

/**
 * 通話 1 本の進行状況。**これだけを保存すれば webhook から再開できる。**
 * 取次の位置（どこまで撃ったか）と通話の状態（相手がどう応じたか）は別物なので両方持つ。
 */
export type CallProgress = {
  readonly position: RoutingPosition;
  readonly voiceState: VoiceCallState;
  /** 取次が確定済みか。確定後のイベントで進めないための材料。 */
  readonly settled: boolean;
  /** この**取次**で処理したイベント数。上限（`maxEvents`）の判定に使う (#646)。 */
  readonly eventCount: number;
};

/**
 * **取次 1 本あたり**のイベント上限 (issue #4 Inc D-2 項目 7 / #646)。
 *
 * webhook は**認証を持たない公開エンドポイント**。署名が正当でも同一通話へイベントを
 * 流し続けられると `position.ledger` が無制限に伸びる。ledger は相関ごと DynamoDB へ
 * 書かれるので **item サイズ上限（400KB）へ向かって育ち**、しかも 1 件ごとに書き込みが走る。
 *
 * 🔴 **通話ごとではなく取次全体で数える。** 2 手目は新しい `providerCallId`＝新しい相関
 * レコードになるので、相関側から数えると必ず 0 に戻り、上限が hop 数だけ緩む。数える値は
 * `RoutingPosition.eventCount` に載せて引き継ぐ（`@/domain/routing/hop-event-budget`）。
 *
 * 正常な取次は数手 × 数イベント（ringing / answered / dtmf / completed）で収まる。
 * hop 上限 10 と併せても 100 は十分に余裕がある。
 */
export const DEFAULT_MAX_EVENTS = 100;

export type WebhookAdvanceOptions = AdvanceOptions & {
  /** 取次 1 本あたりのイベント上限。既定 `DEFAULT_MAX_EVENTS`。 */
  readonly maxEvents?: number;
};

export type WebhookAdvance =
  /** 何もしない。**保存もしない**（duplicate で保存すると位置が余計に進む）。 */
  | {
      readonly kind: 'ignored';
      readonly reason: 'already_settled' | 'duplicate' | 'rate_limited';
    }
  /** 結果は未確定。通話状態だけ保存して発信はしない。 */
  | { readonly kind: 'in_progress'; readonly next: CallProgress }
  /** 次の 1 手を発信する。呼び出し側は next を保存してから発信すること。 */
  | { readonly kind: 'dial'; readonly next: CallProgress; readonly step: RoutingStep }
  /** 取次が確定した。これ以上発信しない。 */
  | {
      readonly kind: 'settled';
      readonly next: CallProgress;
      readonly result?: RouteResult;
      readonly reason: SettleReason;
    };

export function advanceFromWebhook(
  progress: CallProgress,
  event: VoiceCallEvent,
  providerEventId: string,
  policies: ReadonlyArray<RoutingPolicy>,
  options: WebhookAdvanceOptions = {},
): WebhookAdvance {
  // 確定済みなら通話状態すら触らない。確定は取次の終わりで、以降の配信は記録以外の意味を持たない。
  if (progress.settled) return { kind: 'ignored', reason: 'already_settled' };

  // 上限超過は**保存もしない**（書き込み自体が資源消費なので、弾くなら書く前に弾く）。
  if (progress.eventCount >= (options.maxEvents ?? DEFAULT_MAX_EVENTS)) {
    return { kind: 'ignored', reason: 'rate_limited' };
  }
  const eventCount = progress.eventCount + 1;

  // **保存済みの状態から畳む。** ここを 'queued' に固定すると巻き戻し保護が消える（上記）。
  const voiceState = applyVoiceEvent(progress.voiceState, event);
  const result = voiceStateToRouteResult(voiceState);

  // 未確定（呼出中・応答待ち）。位置は据え置き ── 進めると鳴っている最中に次へ発信する。
  if (result === undefined) {
    return { kind: 'in_progress', next: { ...progress, voiceState, eventCount } };
  }

  // 冪等キーは **provider のイベント ID**（webhook の jti）。at-least-once 配信の
  // 二重処理でもう 1 手進むと、応答していない担当者を飛ばして次の人へ発信してしまう。
  const advance = advanceRouting(progress.position, policies, result, providerEventId, options);

  switch (advance.kind) {
    case 'duplicate':
      return { kind: 'ignored', reason: 'duplicate' };
    case 'dial':
      return {
        kind: 'dial',
        next: { position: advance.position, voiceState, settled: false, eventCount },
        step: advance.step,
      };
    case 'settled':
      return {
        kind: 'settled',
        // 確定時は位置を据え置く（次の発信が無いので進める意味が無い）。
        next: { position: progress.position, voiceState, settled: true, eventCount },
        ...(advance.result !== undefined ? { result: advance.result } : {}),
        reason: advance.reason,
      };
  }
}
