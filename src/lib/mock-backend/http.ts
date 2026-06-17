import { NextResponse } from 'next/server';
import type { ReceptionSession } from '@/domain/reception/session';
import type { StoreResult } from './reception-store';

const ERROR_STATUS = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 409,
} as const;

/** StoreResult を NextResponse に変換する。成功時のステータスは指定可能。 */
export function toResponse(result: StoreResult<ReceptionSession>, successStatus = 200): NextResponse {
  if (result.ok) {
    return NextResponse.json(result.value, { status: successStatus });
  }
  return NextResponse.json(
    { error: result.error.code, message: result.error.message },
    { status: ERROR_STATUS[result.error.code] },
  );
}
