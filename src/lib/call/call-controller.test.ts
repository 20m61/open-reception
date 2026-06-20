/**
 * createCallController の単体テスト。実 SDK の代わりに制御可能な fake CallClient を注入し、
 * fetch→接続→connected/timeout 報告→fallback の状態遷移とタイマー挙動を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCallController, type CallClient, type CallTokenResponse } from './call-controller';

const token: CallTokenResponse = {
  applicationId: 'app-1',
  sessionId: 'sess-1',
  token: 'jwt',
  role: 'publisher',
  expiresAt: '2026-01-01T00:00:00.000Z',
};

function makeClient() {
  let saved: Parameters<CallClient['connect']>[0] | undefined;
  return {
    connect: vi.fn(async (opts: Parameters<CallClient['connect']>[0]) => {
      saved = opts;
    }),
    disconnect: vi.fn(async () => {}),
    triggerConnected: () => saved?.onConnected(),
    triggerError: (e: unknown) => saved?.onError(e),
  };
}

function setup(over: Partial<Parameters<typeof createCallController>[0]> = {}) {
  const client = makeClient();
  const reportConnected = vi.fn(async () => {});
  const reportTimeout = vi.fn(async () => {});
  const onState = vi.fn();
  const fetchToken = vi.fn(async () => token as CallTokenResponse | null);
  const ctrl = createCallController({
    fetchToken,
    reportConnected,
    reportTimeout,
    client,
    timeoutMs: 1000,
    onState,
    ...over,
  });
  return { ctrl, client, reportConnected, reportTimeout, onState, fetchToken };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCallController', () => {
  it('falls back when no token is available', async () => {
    const { ctrl, client, onState } = setup({ fetchToken: vi.fn(async () => null) });
    await ctrl.start();
    expect(onState).toHaveBeenCalledWith('fallback');
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('reports connected and cancels the timeout when the call is answered', async () => {
    const { ctrl, client, reportConnected, reportTimeout, onState } = setup();
    await ctrl.start();
    expect(onState).toHaveBeenCalledWith('connecting');
    client.triggerConnected();
    expect(reportConnected).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith('connected');
    vi.advanceTimersByTime(5000);
    expect(reportTimeout).not.toHaveBeenCalled();
  });

  it('reports timeout and disconnects when nobody answers in time', async () => {
    const { ctrl, client, reportTimeout, onState } = setup();
    await ctrl.start();
    vi.advanceTimersByTime(1000);
    expect(reportTimeout).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith('timeout');
  });

  it('degrades to fallback on SDK error but still times out if unanswered', async () => {
    const { ctrl, client, reportTimeout, onState } = setup();
    await ctrl.start();
    client.triggerError(new Error('webrtc'));
    expect(onState).toHaveBeenCalledWith('fallback');
    vi.advanceTimersByTime(1000);
    expect(reportTimeout).toHaveBeenCalledTimes(1);
  });

  it('falls back when connect throws', async () => {
    const { ctrl, onState } = setup({
      client: {
        connect: vi.fn(async () => {
          throw new Error('boom');
        }),
        disconnect: vi.fn(async () => {}),
      },
    });
    await ctrl.start();
    expect(onState).toHaveBeenCalledWith('fallback');
  });

  it('stop() disconnects and prevents a later timeout from firing', async () => {
    const { ctrl, client, reportTimeout } = setup();
    await ctrl.start();
    await ctrl.stop();
    expect(client.disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(reportTimeout).not.toHaveBeenCalled();
  });

  it('does not double-settle when answered then timer would fire', async () => {
    const { ctrl, client, reportConnected, reportTimeout } = setup();
    await ctrl.start();
    client.triggerConnected();
    vi.advanceTimersByTime(5000);
    expect(reportConnected).toHaveBeenCalledTimes(1);
    expect(reportTimeout).not.toHaveBeenCalled();
  });
});
