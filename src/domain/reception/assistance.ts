import type { ReceptionState } from './state';

/**
 * 入力途中の有人支援契約 (#1074)。
 *
 * `ReceptionState` とは直交する UI/journey mode として扱う。
 * 目的は「受付の進捗」を別状態へ移すことではなく、現在の purpose / target / visitor draft を
 * 保ったまま、人へ相談できる一時的な支援レイヤを重ねること。
 *
 * call failure 後の `fallback` / `USE_FALLBACK` とは意味が違うので流用しない。
 */

export const ASSISTANCE_ELIGIBLE_STATES: ReadonlySet<ReceptionState> = new Set<ReceptionState>([
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
]);

/**
 * サーバ/構成層からKioskへ渡す最小capability。
 * 実際の電話番号・provider targetはクライアントへ出さず、接続API側が権威的に解決する。
 */
export type AssistanceCapability =
  | {
      status: 'available';
      /** 来訪者へ期待値を伝えるための媒体。接続先識別子ではない。 */
      channel: 'voice' | 'video' | 'staff_call';
    }
  | {
      status: 'unavailable';
      reason: 'not_configured' | 'out_of_hours' | 'provider_unavailable';
    };

export type AssistanceAvailability =
  | { available: true; channel: 'voice' | 'video' | 'staff_call' }
  | {
      available: false;
      reason:
        | 'state_not_eligible'
        | 'offline'
        | 'not_configured'
        | 'out_of_hours'
        | 'provider_unavailable';
    };

/**
 * 「受付担当に相談する」CTAを出してよいか。
 * available=falseなのに「おつなぎします」と約束するUIを作らないための単一判定口。
 */
export function assistanceAvailabilityFor({
  state,
  online,
  capability,
}: {
  state: ReceptionState;
  online: boolean;
  capability: AssistanceCapability;
}): AssistanceAvailability {
  if (!ASSISTANCE_ELIGIBLE_STATES.has(state)) {
    return { available: false, reason: 'state_not_eligible' };
  }
  if (!online) {
    return { available: false, reason: 'offline' };
  }
  if (capability.status === 'unavailable') {
    return { available: false, reason: capability.reason };
  }
  return { available: true, channel: capability.channel };
}

export type AssistanceModeState =
  | { mode: 'inactive' }
  | { mode: 'requesting'; channel: 'voice' | 'video' | 'staff_call' }
  | { mode: 'connected'; channel: 'voice' | 'video' | 'staff_call' }
  | { mode: 'failed'; reason: 'request_failed' | 'connection_lost' };

export type AssistanceModeEvent =
  | { type: 'REQUEST'; availability: AssistanceAvailability }
  | { type: 'CONNECTED' }
  | { type: 'FAILED'; reason: 'request_failed' | 'connection_lost' }
  | { type: 'CLOSE' };

export const INITIAL_ASSISTANCE_MODE: AssistanceModeState = { mode: 'inactive' };

/**
 * ReceptionStateを一切変更しない独立reducer。
 * - availability=falseのREQUESTはno-op（虚偽接続を開始しない）
 * - requesting→connected/failedだけを許可
 * - CLOSEで元の受付画面へ戻れる
 */
export function assistanceModeReducer(
  state: AssistanceModeState,
  event: AssistanceModeEvent,
): AssistanceModeState {
  if (event.type === 'CLOSE') return INITIAL_ASSISTANCE_MODE;

  if (event.type === 'REQUEST') {
    if (!event.availability.available) return state;
    return { mode: 'requesting', channel: event.availability.channel };
  }

  if (event.type === 'CONNECTED') {
    if (state.mode !== 'requesting') return state;
    return { mode: 'connected', channel: state.channel };
  }

  if (event.type === 'FAILED') {
    if (state.mode !== 'requesting' && state.mode !== 'connected') return state;
    return { mode: 'failed', reason: event.reason };
  }

  return state;
}

/**
 * 支援mode中も受付本体のstateを進めないことを明示する。UI側はこの値を使って入力screenを
 * 隠す/弱めるだけで、`USE_FALLBACK` や `CONFIRM` を代理dispatchしない。
 */
export function shouldSuspendReceptionInteraction(state: AssistanceModeState): boolean {
  return state.mode === 'requesting' || state.mode === 'connected';
}
