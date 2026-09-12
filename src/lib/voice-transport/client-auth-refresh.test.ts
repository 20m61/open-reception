import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceTransportClient } from './client';
import type { VoiceTransportSocket, VoiceTransportSocketCloseInfo, VoiceTransportSocketFactory } from './socket';

class MockSocket implements VoiceTransportSocket {
  onopen: (() => void) | null = null;
  onclose: ((info: VoiceTransportSocketCloseInfo) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  closed = false;

  send(): void {}

  close(): void {
    this.closed = true;
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerClose(): void {
    this.closed = true;
    this.onclose?.({ code: 1006, reason: 'network' });
  }
}

function config(
  prepareSocketFactory: () => Promise<VoiceTransportSocketFactory>,
  fallbackFactory: VoiceTransportSocketFactory,
) {
  return {
    url: 'wss://realtime.example.invalid/v1/voice?kioskId=kiosk-1&receptionSessionId=reception-1',
    socketFactory: fallbackFactory,
    prepareSocketFactory,
    queueLimits: { maxChunks: 5, maxBytes: 5_000, dropPolicy: 'drop-oldest' as const },
    rateLimit: { capacity: 1000, refillPerMs: 1000 },
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    reconnect: { backoff: { baseMs: 100, maxMs: 1_000 }, maxAttempts: 2 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceTransportClient — single-use token refresh boundary', () => {
  it('prepares a new authenticated socket factory for every reconnect attempt', async () => {
    const sockets: MockSocket[] = [];
    const preparedGenerations: number[] = [];
    const fallbackFactory = vi.fn(() => {
      throw new Error('static factory must not be used when prepareSocketFactory is configured');
    });
    const prepareSocketFactory = vi.fn(async () => {
      const generation = preparedGenerations.length + 1;
      preparedGenerations.push(generation);
      return () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      };
    });

    const client = new VoiceTransportClient(config(prepareSocketFactory, fallbackFactory));
    client.connect();
    await vi.runAllTicks();

    expect(prepareSocketFactory).toHaveBeenCalledTimes(1);
    expect(preparedGenerations).toEqual([1]);
    expect(sockets).toHaveLength(1);
    sockets[0]!.triggerOpen();

    sockets[0]!.triggerClose();
    expect(client.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(101);
    expect(prepareSocketFactory).toHaveBeenCalledTimes(2);
    expect(preparedGenerations).toEqual([1, 2]);
    expect(sockets).toHaveLength(2);
    expect(fallbackFactory).not.toHaveBeenCalled();

    sockets[1]!.triggerOpen();
    expect(client.state).toBe('connected');
  });

  it('treats token/factory preparation failure as a reconnectable connection failure', async () => {
    const fallbackFactory = vi.fn(() => new MockSocket());
    const prepareSocketFactory = vi
      .fn<() => Promise<VoiceTransportSocketFactory>>()
      .mockRejectedValueOnce(new Error('token endpoint unavailable'))
      .mockResolvedValueOnce(() => new MockSocket());

    const client = new VoiceTransportClient(config(prepareSocketFactory, fallbackFactory));
    client.connect();
    await vi.runAllTicks();

    expect(client.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(101);
    expect(prepareSocketFactory).toHaveBeenCalledTimes(2);
    expect(client.state).toBe('connecting');
  });

  it('invalidates an in-flight token preparation when the client is closed', async () => {
    let resolvePreparation: ((factory: VoiceTransportSocketFactory) => void) | undefined;
    const prepareSocketFactory = vi.fn(
      () =>
        new Promise<VoiceTransportSocketFactory>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const preparedFactory = vi.fn(() => new MockSocket());
    const fallbackFactory = vi.fn(() => new MockSocket());
    const client = new VoiceTransportClient(config(prepareSocketFactory, fallbackFactory));

    client.connect();
    expect(prepareSocketFactory).toHaveBeenCalledTimes(1);
    await client.close();
    resolvePreparation?.(preparedFactory);
    await vi.runAllTicks();

    expect(preparedFactory).not.toHaveBeenCalled();
    expect(fallbackFactory).not.toHaveBeenCalled();
    expect(client.state).toBe('closed');
  });
});
