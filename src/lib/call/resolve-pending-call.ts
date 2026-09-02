/**
 * 実 PSTN 通話の遅延確定 (#647)。
 *
 * ## どこで確定するか
 *
 * 実発信 (#4 Inc D-2 項目 2) の受付は `'calling'` で止まる。webhook は相関を進めるが
 * 受付の状態は動かさないので、**確定させる者がここまで居なかった**。
 *
 * 確定の機会は `/api/kiosk/receptions/:id/status` の**読み時**だけ（2026-08-08 ユーザー判断）。
 * 定期 sweeper（EventBridge）は継続的な AWS 費用になるので採らない。端末が呼び出し中に
 * ポーリングしている間に確定する ── **確定が要るのは来訪者が待っている間だけ**という整理。
 *
 * ## 例外を投げない
 *
 * 🔴 ここで投げると `/status` そのものが落ち、端末は呼び出し中の表示すら更新できなくなる。
 * 確定できなかったときは `'pending'` を返すだけにして、次のポーリングへ委ねる。
 */
import { resolveCallResolution, type CallCorrelationView } from '@/domain/call/call-resolution';

/** 判定に要る分だけの受付ビュー。 */
export type PendingCallReception = {
  readonly id: string;
  readonly state: string;
  /** 実 PSTN 発信のときだけ在る相関キー。ビデオ経路・mock 経路では undefined。 */
  readonly providerCallId?: string;
};

export type ResolvePendingCallDeps = {
  loadCorrelation: (providerCallId: string) => Promise<CallCorrelationView | undefined>;
  markConnected: (receptionId: string) => Promise<unknown>;
  markTimeout: (receptionId: string) => Promise<unknown>;
  markCallFailed: (receptionId: string, reason?: string) => Promise<unknown>;
  now?: () => number;
};

/**
 * `'unchanged'` … 対象外（呼び出し中でない / 実 PSTN 経路でない）
 * `'pending'`   … 対象だがまだ確定できない（読めなかった・書けなかった場合も含む）
 */
export type ResolvePendingCallOutcome =
  | 'unchanged'
  | 'pending'
  | 'connected'
  | 'timeout'
  | 'failed';

export async function resolvePendingCall(
  reception: PendingCallReception,
  deps: ResolvePendingCallDeps,
): Promise<ResolvePendingCallOutcome> {
  if (reception.state !== 'calling') return 'unchanged';

  // 🔴 ビデオ経路の `'calling'` をここで触らない。ビデオビュー側の確定と二重になる。
  const { providerCallId } = reception;
  if (providerCallId === undefined || providerCallId === '') return 'unchanged';

  let correlation: CallCorrelationView | undefined;
  try {
    correlation = await deps.loadCorrelation(providerCallId);
  } catch {
    console.warn(JSON.stringify({ event: 'pending_call_correlation_read_failed' }));
    return 'pending';
  }
  // 不在から結果をでっち上げない（相関が無い＝結果が分からない、であって未応答ではない）。
  if (correlation === undefined) return 'pending';

  const resolution = resolveCallResolution(correlation, deps.now?.() ?? Date.now());
  if (resolution.kind === 'pending') return 'pending';

  try {
    switch (resolution.kind) {
      case 'connected':
        await deps.markConnected(reception.id);
        return 'connected';
      case 'timeout':
        await deps.markTimeout(reception.id);
        return 'timeout';
      case 'failed':
        await deps.markCallFailed(reception.id, resolution.reason);
        return 'failed';
    }
  } catch {
    // 書けなかったので確定を主張しない。次のポーリングで再試行される。
    console.warn(
      JSON.stringify({ event: 'pending_call_write_failed', resolution: resolution.kind }),
    );
    return 'pending';
  }
}
