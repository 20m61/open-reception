/**
 * 呼び出し中(calling)の経過フィードバック・段階的ケアの純ロジック (issue #323)。
 *
 * 背景: `calling` は来訪者が最も不安になる待ち時間だが、従来の CallingView は静止画面で
 * 「進んでいるのか固まっているのか」が分からなかった。本モジュールは「経過時間 → 表示段階」を
 * 導出する UI 層のタイマー派生ロジックのみを扱う。
 *
 * 設計原則（docs/reception-ux-contract.md 遵守）:
 *  - 状態の所有者はあくまで `state.ts` の `ReceptionState` / `transition`。`calling` は
 *    ここで扱う経過中も終始 `calling` のまま変わらない（新しい screenState は作らない）。
 *  - `ui-contract.ts` の `AvatarState` / その写像も変更しない。段階演出は KioskFlow（UI 層）が
 *    `calling` の間だけローカルに持つタイマー派生の付随情報（avatarState 自体は 'calling' のまま）。
 *  - 副作用なし（Date.now() やタイマーは呼び出し側=UI 層が持ち、経過 ms を渡す）。
 *  - PII を一切扱わない。
 */

/**
 * 呼び出し中の表示段階。
 *  - dialing: 呼び出し開始直後（〜waitingAfterMs）。
 *  - waiting: 少し長引いている（waitingAfterMs 〜 noticeAfterMs）。
 *  - preTimeoutNotice: タイムアウト直前の予告（noticeAfterMs 以降）。実際の CALL_TIMEOUT
 *    遷移（state.ts）は、この段階を最低 noticeMinDurationMs 分見せてから起こす
 *    （UI 層が dispatch のタイミングを遅らせるだけで、遷移表自体は変えない）。
 */
export const CALLING_STAGES = ['dialing', 'waiting', 'preTimeoutNotice'] as const;
export type CallingStage = (typeof CALLING_STAGES)[number];

/** 段階しきい値・予告保持時間（すべてミリ秒）。テナント設定 (#28) / E2E クエリで上書き可能。 */
export type CallingStageThresholds = {
  /** この経過 ms 以降は 'waiting' 段階。 */
  waitingAfterMs: number;
  /** この経過 ms 以降は 'preTimeoutNotice' 段階（タイムアウト直前の予告）。 */
  noticeAfterMs: number;
  /**
   * 予告段階を最低どれだけ見せてから、実際の CALL_TIMEOUT 遷移（dispatch）を許可するか。
   * 「タイムアウトへの遷移が予告付きで、突然感がない」(#323 AC) を保証するための保持時間。
   */
  noticeMinDurationMs: number;
};

/**
 * 既定しきい値。Vonage の応答待ち上限（`KioskCallView.CALL_TIMEOUT_MS` = 30s）と体感を
 * 揃え、「予告 → 保持 → 実遷移」までの合計（noticeAfterMs + noticeMinDurationMs）が
 * およそ 30s になるよう選定（25s で予告を出し、最低 5s は見せてから遷移する）。
 */
export const DEFAULT_CALLING_STAGE_THRESHOLDS: CallingStageThresholds = {
  waitingAfterMs: 15_000,
  noticeAfterMs: 25_000,
  noticeMinDurationMs: 5_000,
};

/** しきい値として受け付ける最小値（0 や負値・NaN 等の壊れた設定を弾く）。 */
const MIN_THRESHOLD_MS = 100;
/** waitingAfterMs と noticeAfterMs の最低差（順序不変条件を保つための最小マージン）。 */
const MIN_STAGE_GAP_MS = 100;

function normalizePositive(value: number | undefined | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_THRESHOLD_MS
    ? value
    : fallback;
}

/**
 * 部分的な上書き（テナント設定 / E2E クエリパラメータ由来）を既定値へマージし、
 * 不変条件（`noticeAfterMs` は `waitingAfterMs` より必ず後）を保った完全なしきい値にする。
 * 純関数（バリデーションのみ・I/O なし）。
 *
 * @param input 上書きしたい値（一部のみ・不正値は無視して fallback を使う）。
 * @param base マージ先の既定値（省略時は `DEFAULT_CALLING_STAGE_THRESHOLDS`）。
 *   テナント設定を先に適用してから E2E クエリを重ねる、といった多段マージに使う。
 */
export function clampCallingStageThresholds(
  input?: Partial<CallingStageThresholds> | null,
  base: CallingStageThresholds = DEFAULT_CALLING_STAGE_THRESHOLDS,
): CallingStageThresholds {
  const waitingAfterMs = normalizePositive(input?.waitingAfterMs, base.waitingAfterMs);
  const noticeMinDurationMs = normalizePositive(input?.noticeMinDurationMs, base.noticeMinDurationMs);
  const noticeCandidate = normalizePositive(input?.noticeAfterMs, base.noticeAfterMs);
  const noticeAfterMs =
    noticeCandidate >= waitingAfterMs + MIN_STAGE_GAP_MS
      ? noticeCandidate
      : waitingAfterMs + MIN_STAGE_GAP_MS;
  return { waitingAfterMs, noticeAfterMs, noticeMinDurationMs };
}

/** 経過 ms としきい値から表示段階を導出する。純関数。 */
export function deriveCallingStage(
  elapsedMs: number,
  thresholds: CallingStageThresholds = DEFAULT_CALLING_STAGE_THRESHOLDS,
): CallingStage {
  if (elapsedMs >= thresholds.noticeAfterMs) return 'preTimeoutNotice';
  if (elapsedMs >= thresholds.waitingAfterMs) return 'waiting';
  return 'dialing';
}

/**
 * 実際の CALL_TIMEOUT dispatch を遅らせるべき残り ms（0 なら即時発火してよい）。
 *
 * 「予告（preTimeoutNotice）を最低 noticeMinDurationMs は見せてから実遷移する」を保証する
 * 純計算。呼び出し側（KioskFlow）は、呼び出し結果が確定した時点の経過 ms をここへ渡し、
 * 返り値が 0 より大きければその ms だけ dispatch を遅延させる（state.ts の遷移表自体は
 * 変更しない。UI 層が「いつ dispatch するか」を制御するだけ）。
 */
export function timeoutDispatchDelayMs(
  elapsedMs: number,
  thresholds: CallingStageThresholds = DEFAULT_CALLING_STAGE_THRESHOLDS,
): number {
  const earliestMs = thresholds.noticeAfterMs + thresholds.noticeMinDurationMs;
  return Math.max(0, earliestMs - elapsedMs);
}
