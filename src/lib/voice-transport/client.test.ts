/**
 * `VoiceTransportClient` — 音声 Transport のクライアント側ライフサイクル統合 (issue #369)。
 *
 * 実 WebSocket/AudioWorklet を使わず、`VoiceTransportSocket` を満たすテストダブル
 * （`MockSocket`）と `vi.useFakeTimers()` で駆動する（interface + mock 先行、実機/実 WSS
 * 検証は #65）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceTransportClient } from './client';
import type { VoiceTransportSocket, VoiceTransportSocketCloseInfo } from './socket';

class MockSocket implements VoiceTransportSocket {
  sent: ArrayBuffer[] = [];
  closed = false;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onclose: ((info: VoiceTransportSocketCloseInfo) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;

  send(chunk: ArrayBuffer): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(chunk);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls.push({ code, reason });
  }
  triggerOpen(): void {
    this.onopen?.();
  }
  triggerClose(info: VoiceTransportSocketCloseInfo = {}): void {
    this.closed = true;
    this.onclose?.(info);
  }
  triggerMessage(data: unknown = 'ack'): void {
    this.onmessage?.(data);
  }
}

function buf(byteLength: number): ArrayBuffer {
  return new ArrayBuffer(byteLength);
}

function makeClient(overrides: Partial<ConstructorParameters<typeof VoiceTransportClient>[0]> = {}) {
  const sockets: MockSocket[] = [];
  const factory = () => {
    const s = new MockSocket();
    sockets.push(s);
    return s;
  };
  const onFallback = vi.fn();
  const onLifecycleChange = vi.fn();
  const onEvalEvent = vi.fn();

  const client = new VoiceTransportClient(
    {
      url: 'wss://example.invalid/voice',
      socketFactory: factory,
      queueLimits: { maxChunks: 5, maxBytes: 5_000, dropPolicy: 'drop-oldest' },
      rateLimit: { capacity: 1000, refillPerMs: 1000 }, // 実質無制限（キュー境界のテストを rate limit と混ぜない）
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 2_000,
      idleTimeoutMs: 30_000,
      reconnect: { backoff: { baseMs: 200, maxMs: 2_000 }, maxAttempts: 2 },
      ...overrides,
    },
    { onFallback, onLifecycleChange, onEvalEvent },
  );
  return { client, sockets, onFallback, onLifecycleChange, onEvalEvent };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceTransportClient — connection and continuous chunk sending', () => {
  it('sends a chunk immediately once the socket is open', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    const a = buf(100);
    client.sendAudioChunk(a);
    expect(sockets[0]!.sent).toEqual([a]);
  });

  it('buffers chunks sent before the socket opens and flushes them in order once connected', () => {
    const { client, sockets } = makeClient();
    client.connect();
    const a = buf(100);
    const b = buf(100);
    client.sendAudioChunk(a);
    client.sendAudioChunk(b);
    expect(sockets[0]!.sent).toEqual([]); // まだ open していない
    sockets[0]!.triggerOpen();
    expect(sockets[0]!.sent).toEqual([a, b]); // 到着順を保って送出
  });

  it('keeps sending continuously as more chunks arrive while connected', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    for (let i = 0; i < 10; i += 1) client.sendAudioChunk(buf(50));
    expect(sockets[0]!.sent).toHaveLength(10);
  });
});

describe('VoiceTransportClient — bounded queue (backpressure)', () => {
  it('never grows the queue beyond maxChunks even when the socket never opens', () => {
    const { client } = makeClient();
    client.connect(); // まだ connecting — ソケットは open しない
    for (let i = 0; i < 500; i += 1) client.sendAudioChunk(buf(10));
    expect(client.queueDepth).toBeLessThanOrEqual(5);
  });

  it('reports dropped chunk count once the bound is exceeded (observability for transport.stats)', () => {
    const { client } = makeClient();
    client.connect();
    for (let i = 0; i < 20; i += 1) client.sendAudioChunk(buf(10));
    expect(client.droppedChunkCount).toBeGreaterThan(0);
  });
});

describe('VoiceTransportClient — reconnect from a transient network drop', () => {
  it('buffers chunks while reconnecting and resumes sending them once reconnected, without reordering', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    const a = buf(100);
    client.sendAudioChunk(a);
    expect(sockets[0]!.sent).toEqual([a]);

    sockets[0]!.triggerClose(); // 一時的なネットワーク断
    const b = buf(100);
    client.sendAudioChunk(b); // 断中でもキューに積める（失われない）
    expect(client.state).toBe('reconnecting');

    vi.advanceTimersByTime(300); // backoff (base=200ms) 経過 → 再接続試行
    expect(sockets).toHaveLength(2);
    sockets[1]!.triggerOpen();
    expect(client.state).toBe('connected');
    expect(sockets[1]!.sent).toEqual([b]); // 断中に積んだチャンクを順序通り再送
  });

  it('grows the backoff delay across successive reconnect attempts (does not hammer the server)', () => {
    const { client, sockets } = makeClient({ reconnect: { backoff: { baseMs: 200, maxMs: 5_000 }, maxAttempts: 5 } });
    client.connect();
    sockets[0]!.triggerOpen();
    sockets[0]!.triggerClose();

    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(1); // 200ms 未満ではまだ再試行しない
    vi.advanceTimersByTime(2);
    expect(sockets).toHaveLength(2); // 200ms で 1 回目

    sockets[1]!.triggerClose();
    vi.advanceTimersByTime(399);
    expect(sockets).toHaveLength(2); // 400ms 未満ではまだ
    vi.advanceTimersByTime(2);
    expect(sockets).toHaveLength(3); // 400ms で 2 回目（指数バックオフ）
  });
});

describe('VoiceTransportClient — give up and fallback', () => {
  it('gives up after exhausting reconnect attempts and requires a touch fallback exactly once', () => {
    const { client, sockets, onFallback } = makeClient({
      reconnect: { backoff: { baseMs: 100, maxMs: 1_000 }, maxAttempts: 2 },
    });
    client.connect();
    sockets[0]!.triggerOpen();
    sockets[0]!.triggerClose(); // attempt 1 scheduled
    vi.advanceTimersByTime(100);
    sockets[1]!.triggerClose(); // attempt 1 failed, attempt 2 scheduled
    vi.advanceTimersByTime(200);
    sockets[2]!.triggerClose(); // attempt 2 failed, exhausted → degraded

    expect(client.state).toBe('degraded');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'reconnect_exhausted' }));
  });

  it('does not fire the fallback callback for merely-in-progress reconnection', () => {
    const { client, sockets, onFallback } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    sockets[0]!.triggerClose();
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe('VoiceTransportClient — close hooks and idempotent close', () => {
  it('runs every registered close hook exactly once, even when close() is called twice', async () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    const sttClose = vi.fn();
    const ttsClose = vi.fn();
    client.registerCloseHook(sttClose);
    client.registerCloseHook(ttsClose);

    await client.close();
    await client.close(); // 二重 close

    expect(sttClose).toHaveBeenCalledTimes(1);
    expect(ttsClose).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.closeCalls).toHaveLength(1);
    expect(client.state).toBe('closed');
  });

  it('a deliberate close does not require a touch fallback', async () => {
    const { client, sockets, onFallback } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    await client.close();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('sending a chunk after close is a no-op (does not throw, does not touch a closed socket)', async () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    await client.close();
    expect(() => client.sendAudioChunk(buf(10))).not.toThrow();
    expect(sockets[0]!.sent).toEqual([]);
  });
});

describe('VoiceTransportClient — idle timeout vs heartbeat timeout', () => {
  it('closes (not a failure) after idleTimeoutMs with no audio activity', () => {
    // heartbeat はこのテストの対象外 — idle timeout より確実に後で発火する間隔にしておく
    // （さもないと mock が pong を返さないため heartbeat timeout が先に発火し、別の分岐に入る）。
    const { client, sockets, onFallback } = makeClient({ idleTimeoutMs: 10_000, heartbeatIntervalMs: 100_000 });
    client.connect();
    sockets[0]!.triggerOpen();
    vi.advanceTimersByTime(10_001);
    expect(client.state).toBe('closed');
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('sending chunks resets the idle timer (an active stream is not idle-closed)', () => {
    const { client, sockets } = makeClient({ idleTimeoutMs: 1_000 });
    client.connect();
    sockets[0]!.triggerOpen();
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(600);
      client.sendAudioChunk(buf(10));
    }
    expect(client.state).toBe('connected');
  });

  it('reconnects (not closes) when the heartbeat ack does not arrive in time (half-open connection)', () => {
    const { client, sockets } = makeClient({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 500 });
    client.connect();
    sockets[0]!.triggerOpen();
    vi.advanceTimersByTime(1_000); // ping 送出
    vi.advanceTimersByTime(500); // pong 未到着 → HEARTBEAT_TIMEOUT
    expect(client.state).toBe('reconnecting');
  });

  it('a heartbeat ack received in time keeps the connection alive (no reconnect)', () => {
    const { client, sockets } = makeClient({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 500 });
    client.connect();
    sockets[0]!.triggerOpen();
    vi.advanceTimersByTime(1_000); // ping 送出
    sockets[0]!.triggerMessage('pong');
    vi.advanceTimersByTime(500);
    expect(client.state).toBe('connected');
  });
});

describe('VoiceTransportClient — evaluation harness event emission (#365 bridge)', () => {
  it('emits transport.connected / transport.disconnected / transport.reconnecting with monotonically non-decreasing t', () => {
    const { client, sockets, onEvalEvent } = makeClient();
    client.connect();
    sockets[0]!.triggerOpen();
    sockets[0]!.triggerClose();
    vi.advanceTimersByTime(300);

    const types = onEvalEvent.mock.calls.map(([e]) => e.type);
    expect(types).toContain('transport.connected');
    expect(types).toContain('transport.disconnected');
    expect(types).toContain('transport.reconnecting');

    const ts = onEvalEvent.mock.calls.map(([e]) => e.t as number);
    for (let i = 1; i < ts.length; i += 1) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]!);
  });
});
