/**
 * 実 PSTN 通話の遅延確定 (#647)。
 *
 * `/status` の読み時に相関を見て受付を確定させる。**定期 sweeper を持たない**
 * （継続的な AWS 費用を増やさない）ぶん、確定の機会はここしか無い。
 */
import { describe, expect, it, vi } from 'vitest';
import { resolvePendingCall, type PendingCallReception } from './resolve-pending-call';
import type { CallCorrelationView } from '@/domain/call/call-resolution';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

function reception(over: Partial<PendingCallReception> = {}): PendingCallReception {
  return { id: 'rec-1', state: 'calling', providerCallId: 'TEST-call', ...over };
}

function correlation(over: Partial<CallCorrelationView> = {}): CallCorrelationView {
  return {
    voiceState: 'ringing',
    status: 'in_flight',
    dialExpiresAt: '2026-08-08T12:00:30.000Z',
    ...over,
  };
}

function deps(over: Partial<Parameters<typeof resolvePendingCall>[1]> = {}) {
  const calls = { connected: 0, timeout: 0, failed: 0, loaded: 0 };
  const base = {
    loadCorrelation: async () => {
      calls.loaded += 1;
      return correlation();
    },
    markConnected: async () => {
      calls.connected += 1;
    },
    markTimeout: async () => {
      calls.timeout += 1;
    },
    markCallFailed: async () => {
      calls.failed += 1;
    },
    now: () => NOW,
  };
  return { calls, deps: { ...base, ...over } };
}

describe('resolvePendingCall — 読み時に受付を確定させる', () => {
  it('呼び出し中でなければ何もしない（確定済みを蒸し返さない）', async () => {
    const d = deps();
    const r = await resolvePendingCall(reception({ state: 'connected' }), d.deps);
    expect(r).toBe('unchanged');
    expect(d.calls.loaded).toBe(0);
  });

  it('🔴 providerCallId が無ければ相関を読まない（ビデオ経路・mock 経路）', async () => {
    // ビデオ経路の calling をここで触ると、ビデオビューの確定と二重になる。
    const d = deps();
    const r = await resolvePendingCall(reception({ providerCallId: undefined }), d.deps);
    expect(r).toBe('unchanged');
    expect(d.calls.loaded).toBe(0);
  });

  it('まだ呼出中（予算内）なら確定しない', async () => {
    const d = deps();
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('pending');
    expect(d.calls).toMatchObject({ connected: 0, timeout: 0, failed: 0 });
  });

  it('応答済みなら connected として確定する', async () => {
    const d = deps({ loadCorrelation: async () => correlation({ voiceState: 'staff_coming' }) });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('connected');
    expect(d.calls.connected).toBe(1);
  });

  it('未応答なら timeout として確定する', async () => {
    const d = deps({ loadCorrelation: async () => correlation({ voiceState: 'no_answer' }) });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('timeout');
    expect(d.calls.timeout).toBe(1);
  });

  it('発信失敗なら failed として確定する', async () => {
    const d = deps({ loadCorrelation: async () => correlation({ voiceState: 'failed' }) });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('failed');
    expect(d.calls.failed).toBe(1);
  });

  it('🔴 webhook が一度も来なくても、予算を過ぎたら timeout として確定する', async () => {
    const d = deps({
      loadCorrelation: async () =>
        correlation({ voiceState: 'ringing', dialExpiresAt: '2026-08-08T11:59:00.000Z' }),
    });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('timeout');
    expect(d.calls.timeout).toBe(1);
  });

  it('🔴 相関が見つからないときは確定しない（不在から結果をでっち上げない）', async () => {
    const d = deps({ loadCorrelation: async () => undefined });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('pending');
    expect(d.calls).toMatchObject({ connected: 0, timeout: 0, failed: 0 });
  });

  it('🔴 相関の読み取りが失敗しても例外を投げない（/status を落とさない）', async () => {
    // ここで投げると、確定できないどころか**状態の取得そのもの**が止まり、
    // 端末は呼び出し中の表示すら更新できなくなる。
    const d = deps({
      loadCorrelation: async () => {
        throw new Error('backend unavailable');
      },
    });
    const r = await resolvePendingCall(reception(), d.deps);
    expect(r).toBe('pending');
  });

  it('🔴 確定の書き戻しが失敗しても例外を投げない', async () => {
    const d = deps({
      loadCorrelation: async () => correlation({ voiceState: 'no_answer' }),
      markTimeout: async () => {
        throw new Error('write failed');
      },
    });
    const r = await resolvePendingCall(reception(), d.deps);
    // 書けなかったので確定を主張しない（次のポーリングで再試行される）。
    expect(r).toBe('pending');
  });

  it('確定は 1 回だけ書く（同じ結果を二重に記録しない）', async () => {
    const markTimeout = vi.fn(async () => {});
    const d = deps({
      loadCorrelation: async () => correlation({ voiceState: 'busy' }),
      markTimeout,
    });
    await resolvePendingCall(reception(), d.deps);
    expect(markTimeout).toHaveBeenCalledTimes(1);
  });
});
