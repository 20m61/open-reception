/**
 * 接続トークンの単回性（リプレイ拒否）を担う store (issue #369)。
 *
 * interface を切っておき、既定は in-memory 実装（プロセス内・単一 Lambda インスタンスの
 * 生存期間のみ有効）。複数インスタンス/コールドスタートを跨いだ厳密な単回性が必要になれば
 * DynamoDB 実装へ差し替える（このモジュールが唯一の境界）。トークン自体が短命
 * （既定 2 分, `DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS`）なため、コールドスタート直後の
 * ごく短い窓を除けば in-memory でも実用上のリプレイ対策になる。実配備を跨ぐ厳密化は
 * インフラ変更を伴うため #65 スコープとする。
 */

export interface VoiceTransportReplayGuard {
  /**
   * jti を消費済みとして記録する。初回なら true（許可）、既に消費済みなら false（リプレイ拒否）。
   * `expiresAtMs` は掃除（GC）のためだけに使う値で、token 自体の exp 判定はここでは行わない
   * （token レイヤの責務。cf. `token.ts`）。
   */
  consume(jti: string, expiresAtMs: number): boolean;
  /** 保持中のエントリ数（メモリが無制限に増えないことのテスト・監視用）。 */
  size(): number;
}

/**
 * in-memory 実装。`consume` のたびに期限切れエントリを掃除するため、大量の短命トークンを
 * 発行し続けてもメモリが無制限に増えない。
 */
export function createInMemoryReplayGuard(now: () => number = Date.now): VoiceTransportReplayGuard {
  const consumed = new Map<string, number>(); // jti -> expiresAtMs

  function sweep(): void {
    const t = now();
    for (const [jti, expiresAtMs] of consumed) {
      if (expiresAtMs < t) consumed.delete(jti);
    }
  }

  return {
    consume(jti, expiresAtMs) {
      sweep();
      if (consumed.has(jti)) return false;
      consumed.set(jti, expiresAtMs);
      return true;
    },
    size() {
      return consumed.size;
    },
  };
}
