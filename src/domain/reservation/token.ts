/**
 * 来訪予約トークンの生成と QR payload 仕様 (issue #97, increment 1)。
 *
 * 方針（docs/visit-reservation-design.md §セキュリティ）:
 *   - トークンは Node の crypto による十分なエントロピーのランダム値。
 *   - QR には個人情報を載せず、token を参照する URL のみを載せる。
 *   - 「QR 画像」描画ライブラリの採用は increment 2（design doc にライセンス判断を記録）。
 *     本増分は token 発行と「QR に載せる URL/payload 仕様」の定義までに留める。
 */
import { randomBytes } from 'node:crypto';
import { asReservationToken, type ReservationToken } from './types';

/**
 * トークンのバイト長。32 バイト = 256 bit。
 * base64url で 43 文字となり、総当り・推測は計算上不可能。
 */
export const RESERVATION_TOKEN_BYTES = 32;

/** バイト列を base64url（パディングなし・URL 安全）へ。 */
function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 推測困難な予約トークンを生成する。
 * 個人情報は一切含めず、純粋なランダム値のみ。
 */
export function generateReservationToken(): ReservationToken {
  return asReservationToken(toBase64Url(randomBytes(RESERVATION_TOKEN_BYTES)));
}

/**
 * QR に載せる payload（受付端末がスキャンして開く URL）の仕様。
 *
 * 形式: `<baseUrl>/kiosk/checkin?rt=<token>`
 *   - token のみを参照する。氏名・会社名・担当者名などの PII は載せない。
 *   - クエリ名は `rt`（reservation token）。
 *
 * baseUrl は受付端末がアクセスする公開オリジン（末尾スラッシュは無視）。
 */
export function buildReservationCheckinUrl(baseUrl: string, token: ReservationToken): string {
  const origin = baseUrl.replace(/\/+$/, '');
  return `${origin}/kiosk/checkin?rt=${encodeURIComponent(token)}`;
}

/** QR payload の token クエリ名（受付端末側の読取と共有する定数）。 */
export const RESERVATION_TOKEN_QUERY = 'rt';

/** checkin URL から token を取り出す（受付端末側の読取で使う）。無効なら null。 */
export function parseReservationCheckinUrl(rawUrl: string): ReservationToken | null {
  try {
    const url = new URL(rawUrl);
    const value = url.searchParams.get(RESERVATION_TOKEN_QUERY);
    return value ? asReservationToken(value) : null;
  } catch {
    return null;
  }
}
