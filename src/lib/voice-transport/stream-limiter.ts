/**
 * kiosk あたりの同時音声ストリーム数を制限する store (issue #369「最大同時ストリーム数を
 * 制限する」)。in-memory 実装（プロセス内）。`replay-guard.ts` と同様、複数インスタンスを
 * 跨いだ厳密な制限が必要になれば差し替える境界として interface を切る。
 */

export interface VoiceTransportStreamLimiter {
  /**
   * 上限内なら acquire して true。既に上限なら false（同一 streamId の再取得は常に true）。
   * `expiresAtMs` を渡すと、実ソケットからの明示 `release` が無くても期限切れで自動解放される
   * （実 WS accept ハンドラが無い段階でも、発行した token の TTL をそのまま同時接続上限の
   * 保持期間として使える。実 WS 実装が入ったら明示 `release` を close hook から呼ぶ）。
   */
  tryAcquire(kioskId: string, streamId: string, maxConcurrent: number, expiresAtMs?: number): boolean;
  /** 解放する。未取得/二重解放でも例外を投げない（冪等）。 */
  release(kioskId: string, streamId: string): void;
  activeCount(kioskId: string): number;
  /** 現在アクティブなストリームを 1 つ以上持つ kiosk 数（メモリリーク検知用）。 */
  trackedKioskCount(): number;
}

export function createInMemoryStreamLimiter(now: () => number = Date.now): VoiceTransportStreamLimiter {
  const byKiosk = new Map<string, Map<string, number>>(); // streamId -> expiresAtMs（Infinity = 要 明示 release）

  function sweep(kioskId: string): Map<string, number> | undefined {
    const map = byKiosk.get(kioskId);
    if (!map) return undefined;
    const t = now();
    for (const [streamId, expiresAtMs] of map) {
      if (expiresAtMs < t) map.delete(streamId);
    }
    if (map.size === 0) {
      byKiosk.delete(kioskId);
      return undefined;
    }
    return map;
  }

  return {
    tryAcquire(kioskId, streamId, maxConcurrent, expiresAtMs = Infinity) {
      const swept = sweep(kioskId);
      const map = swept ?? new Map<string, number>();
      if (map.has(streamId)) return true; // 同一ストリームの再取得は冪等に許可
      if (map.size >= maxConcurrent) return false;
      map.set(streamId, expiresAtMs);
      byKiosk.set(kioskId, map);
      return true;
    },
    release(kioskId, streamId) {
      const map = byKiosk.get(kioskId);
      if (!map) return;
      map.delete(streamId);
      if (map.size === 0) byKiosk.delete(kioskId); // 空になったら破棄 — アイドル kiosk でリークしない
    },
    activeCount(kioskId) {
      return sweep(kioskId)?.size ?? 0;
    },
    trackedKioskCount() {
      return byKiosk.size;
    },
  };
}
