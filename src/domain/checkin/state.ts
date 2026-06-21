/**
 * QR チェックインフローの状態遷移モデル (issue #98, increment 1)。
 *
 * 受付フロー状態機械（src/domain/reception/state.ts）に倣い、状態 × イベントを
 * 明示した遷移表で不正遷移を防ぐ。UI から場当たり的に画面遷移を制御しない。
 *
 * 設計の要点（docs/qr-checkin-design.md）:
 *   - QR 読み取り後は必ず確認画面（confirming）を経由する。resolving から
 *     呼び出し（calling）へ直接遷移する経路は存在しない（確認操作必須）。
 *   - 期限切れ / 使用済み / 失効 / 不正 QR / 通信断 / カメラ不可を別状態として
 *     区別し、UI が文言を出し分ける。
 *   - どのエラー状態からも通常受付（manualFallback）へ完走できる。
 *   - RESET は全状態から idle へ戻す（端末の自動リセット・個人情報を残さない）。
 */

export const CHECKIN_STATES = [
  'idle',
  'selectingMethod',
  'checkingCamera',
  'scanning',
  'resolving',
  'confirming',
  'calling',
  'completed',
  'cancelled',
  'manualFallback',
  // エラー状態（種別ごとに区別する）
  'cameraError',
  'scanError',
  'expiredError',
  'usedError',
  'revokedError',
  'networkError',
] as const;

export type CheckinState = (typeof CHECKIN_STATES)[number];

export const CHECKIN_EVENTS = [
  'START',
  'CHOOSE_QR',
  'CHOOSE_MANUAL',
  'CAMERA_GRANTED',
  'CAMERA_DENIED',
  'QR_DETECTED',
  'SCAN_ERROR',
  'RESERVATION_OK',
  'RESERVATION_EXPIRED',
  'RESERVATION_USED',
  'RESERVATION_REVOKED',
  'RESERVATION_INVALID',
  'RESOLVE_NETWORK_ERROR',
  'CONFIRM',
  'RESCAN',
  'CALL_DONE',
  'CALL_FAILED',
  'USE_MANUAL',
  'RETRY',
  'CANCEL',
  'RESET',
] as const;

export type CheckinEvent = (typeof CHECKIN_EVENTS)[number];

/** エラー状態の集合（どれも USE_MANUAL / RETRY / RESET を許可する）。 */
export const CHECKIN_ERROR_STATES = [
  'cameraError',
  'scanError',
  'expiredError',
  'usedError',
  'revokedError',
  'networkError',
] as const satisfies readonly CheckinState[];

const ERROR_TRANSITIONS: Partial<Record<CheckinEvent, CheckinState>> = {
  USE_MANUAL: 'manualFallback',
  RETRY: 'selectingMethod',
};

function errorState(): Partial<Record<CheckinEvent, CheckinState>> {
  return { ...ERROR_TRANSITIONS };
}

/**
 * 状態遷移表。`[state][event]` が未定義なら不正遷移。
 * RESET は全状態から idle を許可するため transition() で個別に扱う。
 */
const TRANSITIONS: Partial<Record<CheckinState, Partial<Record<CheckinEvent, CheckinState>>>> = {
  idle: {
    START: 'selectingMethod',
  },
  selectingMethod: {
    CHOOSE_QR: 'checkingCamera',
    CHOOSE_MANUAL: 'manualFallback',
    CANCEL: 'idle',
  },
  checkingCamera: {
    CAMERA_GRANTED: 'scanning',
    CAMERA_DENIED: 'cameraError',
    CANCEL: 'idle',
  },
  scanning: {
    QR_DETECTED: 'resolving',
    SCAN_ERROR: 'scanError',
    // 実カメラでは権限プロンプトが読み取り開始時に出るため、scanning 中の
    // カメラ拒否 / 未対応を cameraError として区別する（issue #98, increment 2）。
    CAMERA_DENIED: 'cameraError',
    CANCEL: 'idle',
  },
  resolving: {
    // 確認画面を必ず経由する。calling への直接遷移は存在しない。
    RESERVATION_OK: 'confirming',
    RESERVATION_EXPIRED: 'expiredError',
    RESERVATION_USED: 'usedError',
    RESERVATION_REVOKED: 'revokedError',
    RESERVATION_INVALID: 'scanError',
    RESOLVE_NETWORK_ERROR: 'networkError',
  },
  confirming: {
    // 来訪者の明示操作でのみ前進する（確認必須）。
    CONFIRM: 'calling',
    RESCAN: 'scanning',
    CANCEL: 'cancelled',
  },
  calling: {
    CALL_DONE: 'completed',
    CALL_FAILED: 'networkError',
  },
  cameraError: errorState(),
  scanError: errorState(),
  expiredError: errorState(),
  usedError: errorState(),
  revokedError: errorState(),
  networkError: errorState(),
  manualFallback: {},
  completed: {},
  cancelled: {},
};

/** 終端状態（RESET で待機へ戻る以外の前進がない）。 */
export const CHECKIN_TERMINAL_STATES: ReadonlySet<CheckinState> = new Set<CheckinState>([
  'completed',
  'cancelled',
  'manualFallback',
]);

/**
 * 与えた状態とイベントの遷移先を返す。不正遷移なら null。
 * RESET は安全のため全状態から idle を許可する。
 */
export function transition(state: CheckinState, event: CheckinEvent): CheckinState | null {
  if (event === 'RESET') return 'idle';
  return TRANSITIONS[state]?.[event] ?? null;
}

/** 不正遷移時に例外を投げる版。 */
export function transitionOrThrow(state: CheckinState, event: CheckinEvent): CheckinState {
  const next = transition(state, event);
  if (next === null) {
    throw new Error(`Invalid checkin transition: ${state} -(${event})-> ?`);
  }
  return next;
}

export function isCheckinTerminal(state: CheckinState): boolean {
  return CHECKIN_TERMINAL_STATES.has(state);
}

export function isCheckinError(state: CheckinState): state is (typeof CHECKIN_ERROR_STATES)[number] {
  return (CHECKIN_ERROR_STATES as readonly CheckinState[]).includes(state);
}
