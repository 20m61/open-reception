/**
 * デモ公開の共有トークン (issue #363 Increment 3・公開モデル)。
 *
 * 公開（認証なし閲覧）用の共有リンクに載せるトークン。設計方針は予約トークン
 * （`src/domain/reservation/token.ts`）に倣う:
 *   - **高エントロピー**なランダム値（32 バイト = 256 bit、base64url）。総当り・推測は不可能。
 *   - トークンは**参照子のみ**で、PII・シナリオ内容・publication 内部構造を一切載せない。
 *   - **有効期限は必須**（無期限を作らせない）＋**失効可能**。乱用（拡散後の永続アクセス）を抑止する。
 *     TTL は上限にクランプする。失効は revokedAt を刻むだけで token 値は変えない
 *     （＝以後 `isShareTokenActive` が false になり公開解決が止まる）。
 *
 * 発行/失効の**事実**は route が監査へ残す（PII なし）。本モジュールは純ロジックのみ。
 */
import { randomBytes } from 'node:crypto';

/** トークンのバイト長。32 バイト = 256 bit（base64url で 43 文字）。 */
export const DEMO_SHARE_TOKEN_BYTES = 32;

/** 既定 TTL（24 時間）。デモ共有は短命でよい。 */
export const DEMO_SHARE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** TTL 上限（7 日）。これを超える指定はクランプする（無期限化の防止）。 */
export const DEMO_SHARE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 共有トークン（publication に紐づく。値・発行/失効時刻のみ、PII なし）。 */
export type DemoShareToken = {
  /** base64url の高エントロピー参照子。 */
  token: string;
  /** 発行時刻（ISO）。 */
  issuedAt: string;
  /** 有効期限（ISO・必須）。 */
  expiresAt: string;
  /** 失効時刻（ISO）。設定されていれば期限内でも無効。 */
  revokedAt?: string;
};

function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 推測困難な共有トークン値を生成する（PII を含まない純ランダム値）。 */
export function generateShareTokenValue(): string {
  return toBase64Url(randomBytes(DEMO_SHARE_TOKEN_BYTES));
}

/** トークン値の形式検証（base64url・十分な長さ）。公開経路の入力ガードに使う。 */
export function isValidShareTokenValue(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43,}$/.test(v);
}

/** TTL を [1, MAX] にクランプする（非正は既定へ）。 */
function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || ttlMs <= 0) return DEMO_SHARE_DEFAULT_TTL_MS;
  return Math.min(ttlMs, DEMO_SHARE_MAX_TTL_MS);
}

/** 有効期限付きの共有トークンを発行する。TTL 未指定は既定、上限超過はクランプ。 */
export function issueShareToken(nowMs: number, ttlMs?: number): DemoShareToken {
  const ttl = clampTtl(ttlMs);
  return {
    token: generateShareTokenValue(),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttl).toISOString(),
  };
}

/** トークンを失効させる（冪等：既に失効済みなら最初の失効時刻を保持）。 */
export function revokeShareToken(share: DemoShareToken, nowMs: number): DemoShareToken {
  if (share.revokedAt) return share;
  return { ...share, revokedAt: new Date(nowMs).toISOString() };
}

/** 現在時刻で有効か（失効しておらず・期限内）。 */
export function isShareTokenActive(share: DemoShareToken, nowMs: number): boolean {
  if (share.revokedAt) return false;
  return nowMs < new Date(share.expiresAt).getTime();
}
