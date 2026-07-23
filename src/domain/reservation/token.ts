/**
 * 来訪予約トークンの生成と QR payload 仕様 (issue #97, increment 1)。
 *
 * 方針（docs/visit-reservation-design.md §セキュリティ）:
 *   - トークンは Node の crypto による十分なエントロピーのランダム値。
 *   - QR には個人情報を載せず、token を参照する URL のみを載せる。
 *   - 「QR 画像」描画ライブラリの採用は increment 2（design doc にライセンス判断を記録）。
 *     本増分は token 発行と「QR に載せる URL/payload 仕様」の定義までに留める。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  asReservationToken,
  asReservationTokenHash,
  type ReservationToken,
  type ReservationTokenHash,
} from './types';

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

/** SHA-256 を 16 進で表した hash の文字数（32 バイト = 64 hex）。 */
export const RESERVATION_TOKEN_HASH_HEX_LEN = 64;

/**
 * 予約トークンの一方向 hash を計算する（#375）。
 *
 * - 生 token は永続化せず、この hash（SHA-256・16 進）のみを保存する。
 * - `pepper` は任意の server secret。設定すると DB 流出時の総当り耐性を上げる（keyed hash 相当）。
 *   pepper を変更/導入すると既存 hash は無効化されるため、導入時は再発行または再 hash が要る。
 * - 純関数（server pepper は呼び出し側が env から解決して渡す）。個人情報は入力に含めない。
 */
export function hashReservationToken(
  token: ReservationToken,
  pepper = '',
): ReservationTokenHash {
  const hex = createHash('sha256').update(`${pepper}:${token}`, 'utf8').digest('hex');
  return asReservationTokenHash(hex);
}

/**
 * 2 つの token hash を timing-safe に比較する（#375）。
 * 長さ不一致・不正 hex でも例外を投げず false を返す（照合経路の入力ガード）。
 */
export function reservationTokenHashesEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
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
