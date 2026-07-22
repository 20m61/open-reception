/**
 * 公開デモ経路の固定窓レート制限（純ロジック, issue #363 Increment 3・公開モデル）。
 *
 * 有効期限＋失効（`./share-token.ts`）に加え、公開リンクの短時間の大量アクセス（拡散・スクレイピング）
 * を best-effort で抑える。時刻は呼び出し側が渡す純関数で、状態（`ShareAccessLimiter`）は
 * トークン単位のカウンタ。route 側はプロセス内 Map として保持する（best-effort・多重インスタンスや
 * 再起動を跨いだ厳密性は担保しない。厳密なグローバル制限が要れば #65 のバックエンド側で行う）。
 *
 * 敵対的レビュー W1 対応の二層構造:
 *   - トークン単位の窓（実共有リンク 1 本の scraping 抑止）
 *   - **エンドポイント全体の窓**（トークンを毎回変える回転アクセスでトークン単位の窓を
 *     バイパスされても、未認証経路全体の総量で頭打ちにする）
 * さらにトークン別バケットは上限件数で古い窓から evict し、ランダムトークン連打による
 * Map の無限増大を防ぐ。
 */

export const DEMO_SHARE_RATE_LIMIT = {
  /** 窓の長さ（1 分）。 */
  windowMs: 60 * 1000,
  /** 1 窓・1 トークンあたりの許容アクセス数。 */
  maxPerWindow: 30,
  /** 1 窓・エンドポイント全体の許容アクセス数（トークン回転バイパス対策）。 */
  maxTotalPerWindow: 120,
  /** トークン別バケットの保持上限（超過時は最も古い窓から削除）。 */
  maxTrackedTokens: 512,
} as const;

type Bucket = { windowStart: number; count: number };

/** トークン → バケット + 全体窓。純関数間で受け渡す不変スナップショット。 */
export type ShareAccessLimiter = {
  readonly buckets: ReadonlyMap<string, Bucket>;
  readonly total: Bucket;
};

export function createShareAccessLimiter(): ShareAccessLimiter {
  return { buckets: new Map(), total: { windowStart: 0, count: 0 } };
}

export type ShareAccessResult = {
  allowed: boolean;
  limiter: ShareAccessLimiter;
};

function refresh(bucket: Bucket | undefined, nowMs: number): Bucket {
  if (!bucket || nowMs - bucket.windowStart >= DEMO_SHARE_RATE_LIMIT.windowMs) {
    return { windowStart: nowMs, count: 0 };
  }
  return bucket;
}

/** 保持上限を超えたら最も古い窓のバケットから削る（無限増大防止）。 */
function evictIfNeeded(buckets: Map<string, Bucket>): void {
  while (buckets.size > DEMO_SHARE_RATE_LIMIT.maxTrackedTokens) {
    let oldestKey: string | undefined;
    let oldestStart = Infinity;
    for (const [k, b] of buckets) {
      if (b.windowStart < oldestStart) {
        oldestStart = b.windowStart;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

/**
 * `token` の 1 アクセスを試みる。エンドポイント全体の窓 → トークン単位の窓の順に判定し、
 * どちらかが上限超過なら拒否する。窓が明けていればカウンタをリセットしてから判定する。
 */
export function tryShareAccess(
  limiter: ShareAccessLimiter,
  token: string,
  nowMs: number,
): ShareAccessResult {
  const total = refresh(limiter.total, nowMs);
  const bucket = refresh(limiter.buckets.get(token), nowMs);

  if (
    total.count >= DEMO_SHARE_RATE_LIMIT.maxTotalPerWindow ||
    bucket.count >= DEMO_SHARE_RATE_LIMIT.maxPerWindow
  ) {
    // 超過。状態は据え置き（新窓ならリセット結果を保存する）。
    const buckets = new Map(limiter.buckets);
    buckets.set(token, bucket);
    evictIfNeeded(buckets);
    return { allowed: false, limiter: { buckets, total } };
  }

  const buckets = new Map(limiter.buckets);
  buckets.set(token, { windowStart: bucket.windowStart, count: bucket.count + 1 });
  evictIfNeeded(buckets);
  return {
    allowed: true,
    limiter: { buckets, total: { windowStart: total.windowStart, count: total.count + 1 } },
  };
}
