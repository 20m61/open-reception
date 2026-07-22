/**
 * 公開デモ経路の固定窓レート制限（純ロジック, issue #363 Increment 3・公開モデル）。
 *
 * 有効期限＋失効（`./share-token.ts`）に加え、公開リンクの短時間の大量アクセス（拡散・スクレイピング）
 * を best-effort で抑える。時刻は呼び出し側が渡す純関数で、状態（`ShareAccessLimiter`）は
 * トークン単位のカウンタ。route 側はプロセス内 Map として保持する（best-effort・多重インスタンスや
 * 再起動を跨いだ厳密性は担保しない。厳密なグローバル制限が要れば #65 のバックエンド側で行う）。
 */

export const DEMO_SHARE_RATE_LIMIT = {
  /** 窓の長さ（1 分）。 */
  windowMs: 60 * 1000,
  /** 1 窓・1 トークンあたりの許容アクセス数。 */
  maxPerWindow: 30,
} as const;

type Bucket = { windowStart: number; count: number };

/** トークン → バケット。純関数間で受け渡す不変スナップショット。 */
export type ShareAccessLimiter = ReadonlyMap<string, Bucket>;

export function createShareAccessLimiter(): ShareAccessLimiter {
  return new Map();
}

export type ShareAccessResult = {
  allowed: boolean;
  limiter: ShareAccessLimiter;
};

/**
 * `token` の 1 アクセスを試みる。窓内で上限未満なら許可してカウントを進め、超過なら拒否する。
 * 窓が明けていればカウンタをリセットしてから判定する。
 */
export function tryShareAccess(
  limiter: ShareAccessLimiter,
  token: string,
  nowMs: number,
): ShareAccessResult {
  const current = limiter.get(token);
  const fresh = !current || nowMs - current.windowStart >= DEMO_SHARE_RATE_LIMIT.windowMs;
  const bucket: Bucket = fresh ? { windowStart: nowMs, count: 0 } : current;

  if (bucket.count >= DEMO_SHARE_RATE_LIMIT.maxPerWindow) {
    // 超過。状態は据え置き（新窓ならリセット結果を保存する）。
    const next = new Map(limiter);
    next.set(token, bucket);
    return { allowed: false, limiter: next };
  }

  const next = new Map(limiter);
  next.set(token, { windowStart: bucket.windowStart, count: bucket.count + 1 });
  return { allowed: true, limiter: next };
}
