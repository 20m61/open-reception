/**
 * checkin API のリクエスト解釈ヘルパ (issue #98, increment 1)。
 *
 * - kiosk セッションの検証（#23 readKioskSession を再利用）。管理 API ではなく端末からの
 *   要求であることを担保する。
 * - 失敗理由 → HTTP ステータスの対応。
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import type { CheckinFailureReason } from '@/domain/checkin/types';

/** 有効な kiosk セッションを要求する。無効なら null。 */
export async function requireKioskSession(): Promise<{ kioskId: string } | null> {
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  return readKioskSession(cookie);
}

/** 失敗理由ごとの HTTP ステータス。invalid/not_found は 400/404、状態起因は 409。 */
const STATUS_BY_REASON: Record<CheckinFailureReason, number> = {
  invalid: 400,
  not_found: 404,
  expired: 409,
  used: 409,
  revoked: 409,
};

export function failureResponse(reason: CheckinFailureReason): NextResponse {
  return NextResponse.json({ error: reason }, { status: STATUS_BY_REASON[reason] });
}

/** リクエストボディから payload（QR テキスト = URL or 生 token）を取り出す。 */
export function readPayload(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as Record<string, unknown>).payload;
  return typeof v === 'string' ? v : null;
}
