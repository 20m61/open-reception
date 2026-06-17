/**
 * 受付フローの状態遷移モデル (issue #10)。
 *
 * UI から場当たり的に画面遷移を制御すると、未応答/通信失敗/キャンセル時に
 * 破綻しやすい。状態とイベントを明示し、不正遷移を型と遷移表で防ぐ。
 */

export const RECEPTION_STATES = [
  'idle',
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
  'calling',
  'connected',
  'failed',
  'timeout',
  'cancelled',
  'fallback',
  'completed',
] as const;

export type ReceptionState = (typeof RECEPTION_STATES)[number];

export const RECEPTION_EVENTS = [
  'START',
  'SELECT_PURPOSE',
  'SELECT_TARGET',
  'SUBMIT_VISITOR_INFO',
  'CONFIRM',
  'CALL_CONNECTED',
  'CALL_TIMEOUT',
  'CALL_FAILED',
  'CANCEL',
  'COMPLETE',
  'USE_FALLBACK',
  'BACK',
  'RESET',
] as const;

export type ReceptionEvent = (typeof RECEPTION_EVENTS)[number];

/**
 * 状態遷移表。`[state][event]` が定義されていなければ不正遷移。
 * RESET はどの状態からでも idle に戻せる（自動リセット用）ため、後段で個別に扱う。
 */
const TRANSITIONS: Partial<Record<ReceptionState, Partial<Record<ReceptionEvent, ReceptionState>>>> = {
  idle: {
    START: 'selectingPurpose',
  },
  selectingPurpose: {
    SELECT_PURPOSE: 'selectingTarget',
    CANCEL: 'idle',
  },
  selectingTarget: {
    SELECT_TARGET: 'inputVisitorInfo',
    BACK: 'selectingPurpose',
    CANCEL: 'idle',
  },
  inputVisitorInfo: {
    SUBMIT_VISITOR_INFO: 'confirming',
    BACK: 'selectingTarget',
    CANCEL: 'idle',
  },
  confirming: {
    CONFIRM: 'calling',
    BACK: 'inputVisitorInfo',
    CANCEL: 'cancelled',
  },
  calling: {
    CALL_CONNECTED: 'connected',
    CALL_TIMEOUT: 'timeout',
    CALL_FAILED: 'failed',
    CANCEL: 'cancelled',
  },
  connected: {
    COMPLETE: 'completed',
  },
  timeout: {
    USE_FALLBACK: 'fallback',
    RESET: 'idle',
  },
  failed: {
    USE_FALLBACK: 'fallback',
    RESET: 'idle',
  },
  cancelled: {
    RESET: 'idle',
  },
  fallback: {
    RESET: 'idle',
    COMPLETE: 'completed',
  },
  completed: {
    RESET: 'idle',
  },
};

/** 終端状態（ここからは RESET で待機に戻る以外の前進がない）。 */
export const TERMINAL_STATES: ReadonlySet<ReceptionState> = new Set<ReceptionState>([
  'completed',
  'cancelled',
]);

/**
 * 与えられた状態とイベントの遷移先を返す。不正遷移なら null。
 * RESET は安全のため全状態から idle を許可する（端末の自動リセット）。
 */
export function transition(state: ReceptionState, event: ReceptionEvent): ReceptionState | null {
  if (event === 'RESET') {
    return 'idle';
  }
  return TRANSITIONS[state]?.[event] ?? null;
}

/** 不正遷移時に例外を投げる版。状態を確実に進めたい呼び出し側で使う。 */
export function transitionOrThrow(state: ReceptionState, event: ReceptionEvent): ReceptionState {
  const next = transition(state, event);
  if (next === null) {
    throw new Error(`Invalid reception transition: ${state} -(${event})-> ?`);
  }
  return next;
}

export function isTerminal(state: ReceptionState): boolean {
  return TERMINAL_STATES.has(state);
}
