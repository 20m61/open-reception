/**
 * QR payload から予約トークンを取り出す (issue #98, increment 1)。
 *
 * QR には #97 の仕様で `<baseUrl>/kiosk/checkin?rt=<token>` の URL が載る。
 * 受付端末は URL でも、（手入力フォールバック等で）生の token でも受け付けられるよう、
 * 両方を解釈する。#97 の parseReservationCheckinUrl を import 利用する（編集しない）。
 */
import { asReservationToken, type ReservationToken } from '@/domain/reservation/types';
import { parseReservationCheckinUrl } from '@/domain/reservation/token';

/** token の形式: base64url（英数 + - + _）。長さは固定しないが空・記号混入は弾く。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 読み取ったテキスト（URL or 生 token）から ReservationToken を取り出す。
 * 不正なら null（呼び出し側は invalid として扱う）。
 */
export function extractReservationToken(raw: string): ReservationToken | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;

  // URL 形式（#97 の checkin URL）。
  const fromUrl = parseReservationCheckinUrl(text);
  if (fromUrl) return TOKEN_PATTERN.test(fromUrl) ? fromUrl : null;

  // 生 token（base64url のみ）。URL らしき文字列は弾く。
  if (text.includes('://') || text.includes('/') || text.includes('?')) return null;
  return TOKEN_PATTERN.test(text) ? asReservationToken(text) : null;
}
