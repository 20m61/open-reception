import { describe, it, expect } from 'vitest';
import {
  transition,
  transitionOrThrow,
  isFallbackRequired,
  nextReconnectDelayMs,
  type VoiceTransportLifecycleState,
} from './lifecycle';

describe('voice transport lifecycle transition', () => {
  it('idle -[CONNECT]-> connecting', () => {
    expect(transition('idle', { type: 'CONNECT' })).toBe('connecting');
  });

  it('connecting -[OPENED]-> connected', () => {
    expect(transition('connecting', { type: 'OPENED' })).toBe('connected');
  });

  it('connected -[DISCONNECTED network]-> reconnecting (transient failure retries)', () => {
    expect(transition('connected', { type: 'DISCONNECTED', reason: 'network' })).toBe('reconnecting');
  });

  it('connected -[DISCONNECTED client]-> closed (deliberate close does not retry)', () => {
    expect(transition('connected', { type: 'DISCONNECTED', reason: 'client' })).toBe('closed');
  });

  it('connected -[HEARTBEAT_TIMEOUT]-> reconnecting', () => {
    expect(transition('connected', { type: 'HEARTBEAT_TIMEOUT' })).toBe('reconnecting');
  });

  it('connected -[IDLE_TIMEOUT]-> closed (no audio activity — not a failure)', () => {
    expect(transition('connected', { type: 'IDLE_TIMEOUT' })).toBe('closed');
  });

  it('reconnecting -[RETRY]-> connecting', () => {
    expect(transition('reconnecting', { type: 'RETRY' })).toBe('connecting');
  });

  it('reconnecting -[GIVE_UP]-> degraded (reconnect attempts exhausted)', () => {
    expect(transition('reconnecting', { type: 'GIVE_UP' })).toBe('degraded');
  });

  it('degraded -[RETRY]-> connecting (manual/periodic retry from degraded is allowed)', () => {
    expect(transition('degraded', { type: 'RETRY' })).toBe('connecting');
  });

  it('rejects an undefined transition and stays in the same state', () => {
    expect(transition('idle', { type: 'OPENED' })).toBe('idle');
    expect(transition('idle', { type: 'HEARTBEAT_TIMEOUT' })).toBe('idle');
  });

  it('CLOSE is accepted from every non-closed state and moves to closed', () => {
    const states: VoiceTransportLifecycleState[] = ['idle', 'connecting', 'connected', 'reconnecting', 'degraded'];
    for (const s of states) {
      expect(transition(s, { type: 'CLOSE' })).toBe('closed');
    }
  });

  it('closed is a terminal state: every event is a no-op (idempotent double close)', () => {
    expect(transition('closed', { type: 'CLOSE' })).toBe('closed');
    expect(transition('closed', { type: 'CONNECT' })).toBe('closed');
    expect(transition('closed', { type: 'RETRY' })).toBe('closed');
    expect(transition('closed', { type: 'OPENED' })).toBe('closed');
  });

  it('transitionOrThrow throws on an undefined transition', () => {
    expect(() => transitionOrThrow('idle', { type: 'OPENED' })).toThrow();
  });

  it('transitionOrThrow does not throw for CLOSE from closed (idempotent, not an error)', () => {
    expect(() => transitionOrThrow('closed', { type: 'CLOSE' })).not.toThrow();
  });
});

describe('isFallbackRequired', () => {
  it('is false while healthy or merely retrying a transient failure', () => {
    expect(isFallbackRequired('idle')).toBe(false);
    expect(isFallbackRequired('connecting')).toBe(false);
    expect(isFallbackRequired('connected')).toBe(false);
    expect(isFallbackRequired('reconnecting')).toBe(false);
  });

  it('is true once reconnect attempts are exhausted (degraded) — Kiosk must offer touch fallback', () => {
    expect(isFallbackRequired('degraded')).toBe(true);
  });

  it('is false for a deliberate close (closed via client action carries no fallback need by itself)', () => {
    expect(isFallbackRequired('closed')).toBe(false);
  });
});

describe('nextReconnectDelayMs (exponential backoff with cap)', () => {
  it('grows exponentially from a base delay', () => {
    expect(nextReconnectDelayMs(0, { baseMs: 200, maxMs: 5000 })).toBe(200);
    expect(nextReconnectDelayMs(1, { baseMs: 200, maxMs: 5000 })).toBe(400);
    expect(nextReconnectDelayMs(2, { baseMs: 200, maxMs: 5000 })).toBe(800);
    expect(nextReconnectDelayMs(3, { baseMs: 200, maxMs: 5000 })).toBe(1600);
  });

  it('never exceeds maxMs regardless of attempt count', () => {
    expect(nextReconnectDelayMs(10, { baseMs: 200, maxMs: 5000 })).toBe(5000);
    expect(nextReconnectDelayMs(100, { baseMs: 200, maxMs: 5000 })).toBe(5000);
  });

  it('rejects a negative attempt count as a defensive floor at attempt 0 delay', () => {
    expect(nextReconnectDelayMs(-1, { baseMs: 200, maxMs: 5000 })).toBe(200);
  });
});
