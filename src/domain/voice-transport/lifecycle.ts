/**
 * Transport 接続の lifecycle 状態機械 (issue #369)。
 *
 * `src/domain/reception/state.ts` と同じ流儀（遷移表 + 純関数 `transition`/`transitionOrThrow`）
 * に揃える。ソケット・タイマーなどの I/O は持たない — `src/lib/voice-transport/` がこの reducer を
 * 駆動する側になる。
 *
 * 状態の意味:
 *  - idle: 未接続。
 *  - connecting: 初回接続 or 再接続の試行中。
 *  - connected: 接続確立・健全。
 *  - reconnecting: 接続が失われ、次の試行までのバックオフ待ち。
 *  - degraded: 再接続試行が尽きた（GIVE_UP）。タッチ受付へのフォールバックが必要。
 *  - closed: 終端。以後どのイベントも受け付けない（二重 close を安全に無視する）。
 */

export const VOICE_TRANSPORT_LIFECYCLE_STATES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'degraded',
  'closed',
] as const;

export type VoiceTransportLifecycleState = (typeof VOICE_TRANSPORT_LIFECYCLE_STATES)[number];

/** 切断理由。`client` は意図的な close（フォールバック不要）、それ以外は障害系。 */
export type VoiceTransportDisconnectReason = 'client' | 'server' | 'network' | 'timeout';

export type VoiceTransportLifecycleEvent =
  | { type: 'CONNECT' }
  | { type: 'OPENED' }
  | { type: 'DISCONNECTED'; reason: VoiceTransportDisconnectReason }
  | { type: 'HEARTBEAT_TIMEOUT' }
  | { type: 'IDLE_TIMEOUT' }
  | { type: 'RETRY' }
  | { type: 'GIVE_UP' }
  | { type: 'CLOSE' };

export type VoiceTransportLifecycleEventType = VoiceTransportLifecycleEvent['type'];

type TransitionTable = Partial<
  Record<VoiceTransportLifecycleState, Partial<Record<VoiceTransportLifecycleEventType, VoiceTransportLifecycleState>>>
>;

const TRANSITIONS: TransitionTable = {
  idle: {
    CONNECT: 'connecting',
  },
  connecting: {
    OPENED: 'connected',
    DISCONNECTED: 'reconnecting',
  },
  connected: {
    HEARTBEAT_TIMEOUT: 'reconnecting',
    IDLE_TIMEOUT: 'closed',
  },
  reconnecting: {
    RETRY: 'connecting',
    GIVE_UP: 'degraded',
  },
  degraded: {
    RETRY: 'connecting',
  },
};

/**
 * `connected` からの `DISCONNECTED` だけは reason で分岐する（`client` は意図的な終了として
 * `closed` へ、それ以外は復旧を試みる `reconnecting` へ）。遷移表では表現しづらいためここで扱う。
 */
function connectedDisconnected(reason: VoiceTransportDisconnectReason): VoiceTransportLifecycleState {
  return reason === 'client' ? 'closed' : 'reconnecting';
}

/**
 * 状態遷移。未定義の遷移は現状維持（null を返す `transitionOrThrow` 未使用箇所向けに、こちらは
 * 常に有効な state を返す簡便版）。`closed` は終端 — 以後どのイベントも無視する（二重 close の
 * 安全性を型レベルの分岐なしで保証する）。`CLOSE` はどの非終端状態からも受理する（`RESET` が
 * reception state.ts で全状態から idle に戻せるのと同じ設計）。
 */
export function transition(
  state: VoiceTransportLifecycleState,
  event: VoiceTransportLifecycleEvent,
): VoiceTransportLifecycleState {
  if (state === 'closed') return 'closed';
  if (event.type === 'CLOSE') return 'closed';
  if (state === 'connected' && event.type === 'DISCONNECTED') {
    return connectedDisconnected(event.reason);
  }
  return TRANSITIONS[state]?.[event.type] ?? state;
}

/**
 * 未定義遷移を例外にする版。`transition` は「無視して現状維持」だが、呼び出し側が
 * 「本当に進んだか」を確実に区別したい箇所（テスト・不変条件チェック）で使う。
 */
export function transitionOrThrow(
  state: VoiceTransportLifecycleState,
  event: VoiceTransportLifecycleEvent,
): VoiceTransportLifecycleState {
  // closed は吸収状態 — 二重 close 等をエラーにせず常に許容する（idempotent close）。
  if (state === 'closed') return 'closed';
  const next = transition(state, event);
  if (next === state) {
    throw new Error(`Invalid voice transport lifecycle transition: ${state} -(${event.type})-> ?`);
  }
  return next;
}

/**
 * タッチ受付へのフォールバックが必要かどうか。再接続を使い果たした `degraded` のときだけ true。
 * `closed` 自体はフォールバックの要否を含意しない（意図的な close かもしれないため、要否は
 * `degraded` を経由したかどうかで呼び出し側が判断する）。
 */
export function isFallbackRequired(state: VoiceTransportLifecycleState): boolean {
  return state === 'degraded';
}

export type ReconnectBackoffConfig = {
  baseMs: number;
  maxMs: number;
};

/**
 * 指数バックオフ（2^attempt * baseMs、上限 maxMs）。attempt は 0 始まり。
 * 負の attempt は 0 として扱う（防御的フロア）。
 */
export function nextReconnectDelayMs(attempt: number, config: ReconnectBackoffConfig): number {
  const safeAttempt = Math.max(0, attempt);
  const delay = config.baseMs * 2 ** safeAttempt;
  return Math.min(delay, config.maxMs);
}
