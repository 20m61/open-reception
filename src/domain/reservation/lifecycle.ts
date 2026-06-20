/**
 * 来訪予約ライフサイクルの純関数 (issue #97, increment 1)。
 *
 * すべて副作用なしの純関数。バリデーション・状態遷移を集約し、テーブルテストで網羅する。
 * 永続化・監査・認可は呼び出し側（src/lib/reservation/service.ts）の責務。
 */
import {
  isTerminal,
  type CreateReservationInput,
  type EditReservationPatch,
  type ReservationStatus,
  type ReservationUsagePolicy,
  type VisitReservation,
} from './types';

export type ReservationError = {
  code: 'invalid_input' | 'invalid_state';
  message: string;
};
export type ReservationResult<T> = { ok: true; value: T } | { ok: false; error: ReservationError };

function err(code: ReservationError['code'], message: string): ReservationResult<never> {
  return { ok: false, error: { code, message } };
}

const USAGE_POLICIES: readonly ReservationUsagePolicy[] = ['single_use', 'same_day'];

function isIsoDate(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/** 予約作成入力の検証。PII は最小限・必須項目のみ強制する。 */
export function validateCreateInput(input: CreateReservationInput): ReservationResult<CreateReservationInput> {
  if (!input.visitorName || input.visitorName.trim() === '')
    return err('invalid_input', 'visitorName is required');
  if (!isIsoDate(input.visitAt)) return err('invalid_input', 'visitAt must be an ISO date');
  if (!isIsoDate(input.expiresAt)) return err('invalid_input', 'expiresAt must be an ISO date');
  if (input.targetType !== 'staff' && input.targetType !== 'department')
    return err('invalid_input', 'targetType must be staff or department');
  if (!input.targetId || input.targetId.trim() === '')
    return err('invalid_input', 'targetId is required');
  if (!USAGE_POLICIES.includes(input.usagePolicy))
    return err('invalid_input', 'usagePolicy is invalid');
  if (!Number.isInteger(input.retentionDays) || input.retentionDays <= 0)
    return err('invalid_input', 'retentionDays must be a positive integer');
  if (Date.parse(input.expiresAt) < Date.parse(input.visitAt))
    return err('invalid_input', 'expiresAt must not be before visitAt');
  return { ok: true, value: input };
}

/** 編集パッチの検証（指定されたフィールドのみ検査）。 */
export function validateEditPatch(patch: EditReservationPatch): ReservationResult<EditReservationPatch> {
  if (patch.visitorName !== undefined && patch.visitorName.trim() === '')
    return err('invalid_input', 'visitorName must not be empty');
  if (patch.visitAt !== undefined && !isIsoDate(patch.visitAt))
    return err('invalid_input', 'visitAt must be an ISO date');
  if (patch.expiresAt !== undefined && !isIsoDate(patch.expiresAt))
    return err('invalid_input', 'expiresAt must be an ISO date');
  if (
    patch.targetType !== undefined &&
    patch.targetType !== 'staff' &&
    patch.targetType !== 'department'
  )
    return err('invalid_input', 'targetType must be staff or department');
  if (patch.targetId !== undefined && patch.targetId.trim() === '')
    return err('invalid_input', 'targetId must not be empty');
  if (patch.usagePolicy !== undefined && !USAGE_POLICIES.includes(patch.usagePolicy))
    return err('invalid_input', 'usagePolicy is invalid');
  if (
    patch.retentionDays !== undefined &&
    (!Number.isInteger(patch.retentionDays) || patch.retentionDays <= 0)
  )
    return err('invalid_input', 'retentionDays must be a positive integer');
  return { ok: true, value: patch };
}

/**
 * 予約が期限切れか（有効期限のみで判定する純関数）。
 * same_day の追加判定は isUsableAt で行う。
 */
export function isExpiredAt(reservation: VisitReservation, now: Date): boolean {
  return Date.parse(reservation.expiresAt) <= now.getTime();
}

/** 同一カレンダー日（UTC 基準）か。same_day 制約の判定に使う。 */
function isSameUtcDay(aIso: string, b: Date): boolean {
  const a = new Date(Date.parse(aIso));
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * 受付時点で QR/トークンが利用可能か（受付端末の判定に使う純関数）。
 * - status が active 以外（used/expired/revoked/cancelled）は不可。
 * - 有効期限切れは不可。
 * - same_day は予定日当日内のみ可。
 */
export function isUsableAt(reservation: VisitReservation, now: Date): boolean {
  if (reservation.status !== 'active') return false;
  if (isExpiredAt(reservation, now)) return false;
  if (reservation.usagePolicy === 'same_day' && !isSameUtcDay(reservation.visitAt, now))
    return false;
  return true;
}

/** active からのみ遷移できる操作の共通ガード。 */
function requireActive(
  reservation: VisitReservation,
  op: string,
): ReservationResult<VisitReservation> {
  if (isTerminal(reservation.status))
    return err('invalid_state', `cannot ${op} a ${reservation.status} reservation`);
  return { ok: true, value: reservation };
}

/** 予約をキャンセルする（active → cancelled）。 */
export function cancelReservation(
  reservation: VisitReservation,
  now: Date,
): ReservationResult<VisitReservation> {
  const guard = requireActive(reservation, 'cancel');
  if (!guard.ok) return guard;
  return {
    ok: true,
    value: { ...reservation, status: 'cancelled', updatedAt: now.toISOString() },
  };
}

/** 予約/トークンを失効させる（active → revoked）。再発行時にも使う。 */
export function revokeReservation(
  reservation: VisitReservation,
  now: Date,
): ReservationResult<VisitReservation> {
  const guard = requireActive(reservation, 'revoke');
  if (!guard.ok) return guard;
  return {
    ok: true,
    value: { ...reservation, status: 'revoked', updatedAt: now.toISOString() },
  };
}

/** 期限切れを永続状態へ反映する（active かつ期限切れ → expired）。冪等。 */
export function markExpiredIfNeeded(
  reservation: VisitReservation,
  now: Date,
): ReservationResult<VisitReservation> {
  if (reservation.status !== 'active') return { ok: true, value: reservation };
  if (!isExpiredAt(reservation, now)) return { ok: true, value: reservation };
  return {
    ok: true,
    value: { ...reservation, status: 'expired', updatedAt: now.toISOString() },
  };
}

/** 受付完了で使用済みにする（利用可能な状態からのみ used へ）。 */
export function markUsed(
  reservation: VisitReservation,
  now: Date,
): ReservationResult<VisitReservation> {
  if (!isUsableAt(reservation, now))
    return err('invalid_state', 'reservation is not usable (expired/used/revoked/out of window)');
  return {
    ok: true,
    value: {
      ...reservation,
      status: 'used',
      usedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
}

/**
 * 新しいトークン・有効期限を適用した「再発行後の新予約」を作る純関数。
 * 旧予約は呼び出し側で revoke する（旧トークン失効）。
 */
export function applyReissue(
  reservation: VisitReservation,
  newToken: VisitReservation['token'],
  newExpiresAt: string,
  now: Date,
): ReservationResult<VisitReservation> {
  if (isTerminal(reservation.status) && reservation.status !== 'expired' && reservation.status !== 'revoked')
    return err('invalid_state', `cannot reissue a ${reservation.status} reservation`);
  if (!isIsoDate(newExpiresAt)) return err('invalid_input', 'newExpiresAt must be an ISO date');
  return {
    ok: true,
    value: {
      ...reservation,
      token: newToken,
      expiresAt: newExpiresAt,
      status: 'active',
      usedAt: undefined,
      updatedAt: now.toISOString(),
    },
  };
}

/** 編集パッチを適用する（active のみ編集可）。 */
export function applyEdit(
  reservation: VisitReservation,
  patch: EditReservationPatch,
  now: Date,
): ReservationResult<VisitReservation> {
  const guard = requireActive(reservation, 'edit');
  if (!guard.ok) return guard;
  const validated = validateEditPatch(patch);
  if (!validated.ok) return validated;
  const next: VisitReservation = {
    ...reservation,
    ...stripUndefined(patch),
    updatedAt: now.toISOString(),
  };
  if (Date.parse(next.expiresAt) < Date.parse(next.visitAt))
    return err('invalid_input', 'expiresAt must not be before visitAt');
  return { ok: true, value: next };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 既知の状態かどうかの型ガード。 */
export function isReservationStatus(value: unknown): value is ReservationStatus {
  return (
    value === 'active' ||
    value === 'used' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'cancelled'
  );
}
