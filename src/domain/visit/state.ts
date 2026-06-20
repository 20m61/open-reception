/**
 * 滞在状態ライフサイクルの純関数 (issue #102, increment 1)。
 *
 * すべて副作用なし。状態遷移・派生判定を集約し、テーブルテストで網羅する。
 * 永続化・監査・認可は呼び出し側（src/lib/visit/service.ts）の責務。
 * 予約ライフサイクル（src/domain/reservation/lifecycle.ts）の Result 様式に揃える。
 */
import { isTerminalStay, type VisitStay } from './types';

export type StayError = {
  code: 'invalid_input' | 'invalid_state';
  message: string;
};
export type StayResult<T> = { ok: true; value: T } | { ok: false; error: StayError };

function err(code: StayError['code'], message: string): StayResult<never> {
  return { ok: false, error: { code, message } };
}

/** 滞在時間（ミリ秒）を求める純関数。負値にはしない。 */
export function stayDurationMs(checkedInAt: string, checkedOutAt: string): number {
  const start = Date.parse(checkedInAt);
  const end = Date.parse(checkedOutAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/**
 * 退館チェックアウト（present → checked_out）。
 * 終端（checked_out / cancelled）からの再退館は invalid_state（二重退館防止）。
 * 退館時刻と滞在時間を確定する。
 */
export function checkOut(stay: VisitStay, now: Date): StayResult<VisitStay> {
  if (stay.status !== 'present')
    return err('invalid_state', `cannot check out a ${stay.status} stay`);
  const checkedOutAt = now.toISOString();
  return {
    ok: true,
    value: {
      ...stay,
      status: 'checked_out',
      checkedOutAt,
      durationMs: stayDurationMs(stay.checkedInAt, checkedOutAt),
      updatedAt: checkedOutAt,
    },
  };
}

/**
 * 取消（present → cancelled）。誤登録の訂正に使う。
 * 終端からの取消は invalid_state。
 */
export function cancelStay(stay: VisitStay, now: Date): StayResult<VisitStay> {
  if (isTerminalStay(stay.status))
    return err('invalid_state', `cannot cancel a ${stay.status} stay`);
  return {
    ok: true,
    value: { ...stay, status: 'cancelled', updatedAt: now.toISOString() },
  };
}

/**
 * 未退館（overstay）の派生判定。
 * present かつ checkedInAt から thresholdMs 以上経過していれば true。
 * 終端状態は overstay にならない。独立した永続状態を持たないための純関数。
 */
export function isOverstay(stay: VisitStay, now: Date, thresholdMs: number): boolean {
  if (stay.status !== 'present') return false;
  const start = Date.parse(stay.checkedInAt);
  if (!Number.isFinite(start)) return false;
  return now.getTime() - start >= thresholdMs;
}

/** 現在の滞在時間（present は now まで、退館済みは確定値）。表示用の純関数。 */
export function elapsedMs(stay: VisitStay, now: Date): number {
  if (stay.status === 'checked_out') return stay.durationMs ?? 0;
  return stayDurationMs(stay.checkedInAt, now.toISOString());
}
