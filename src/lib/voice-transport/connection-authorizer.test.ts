/**
 * `authorizeVoiceTransportConnection` — token 提示から接続許可までの唯一の検証経路 (issue #369)。
 *
 * 位置づけ: 実 WSS サーバ（API Gateway WebSocket $connect 相当、実配備は #65／インフラ増分）が
 * 呼び出す想定の関数。ここでは実ソケットを介さず、この関数単体で境界（越境・リプレイ・
 * 同時接続上限）を突く。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { authorizeVoiceTransportConnection } from './connection-authorizer';
import { issueVoiceTransportToken } from './token';
import { createInMemoryReplayGuard } from './replay-guard';
import { createInMemoryStreamLimiter } from './stream-limiter';
import type { VoiceTransportConnectionContext } from '@/domain/voice-transport/types';

const claims = {
  tenantId: 'tenant-1',
  siteId: 'site-1',
  kioskId: 'kiosk-1',
  receptionSessionId: 'reception-1',
  jti: 'jti-1',
};

const context: VoiceTransportConnectionContext = {
  tenantId: 'tenant-1',
  siteId: 'site-1',
  kioskId: 'kiosk-1',
  receptionSessionId: 'reception-1',
};

function makeDeps() {
  return {
    replayGuard: createInMemoryReplayGuard(),
    streamLimiter: createInMemoryStreamLimiter(),
    maxConcurrentStreamsPerKiosk: 2,
  };
}

describe('authorizeVoiceTransportConnection', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('authorizes a fresh, correctly-scoped token', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const result = await authorizeVoiceTransportConnection(token, context, deps);
    expect(result).toEqual({ ok: true, claims });
  });

  it('rejects an undefined/garbage token', async () => {
    expect(await authorizeVoiceTransportConnection(undefined, context, deps)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    expect(await authorizeVoiceTransportConnection('garbage', context, deps)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('rejects a token bound to a different tenant even if kiosk/reception match by coincidence', async () => {
    const { token } = await issueVoiceTransportToken({ ...claims, tenantId: 'tenant-evil' });
    expect(await authorizeVoiceTransportConnection(token, context, deps)).toEqual({
      ok: false,
      reason: 'tenant_mismatch',
    });
  });

  it('rejects a token bound to a different kiosk device (stolen token replayed from another kiosk)', async () => {
    const { token } = await issueVoiceTransportToken({ ...claims, kioskId: 'kiosk-stolen' });
    expect(await authorizeVoiceTransportConnection(token, context, deps)).toEqual({
      ok: false,
      reason: 'kiosk_mismatch',
    });
  });

  it('rejects a token bound to a different reception session', async () => {
    const { token } = await issueVoiceTransportToken({ ...claims, receptionSessionId: 'reception-other' });
    expect(await authorizeVoiceTransportConnection(token, context, deps)).toEqual({
      ok: false,
      reason: 'reception_mismatch',
    });
  });

  it('rejects a replayed token — a second connection attempt with the same token fails even though the token itself is still valid', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const first = await authorizeVoiceTransportConnection(token, context, deps);
    expect(first.ok).toBe(true);
    const second = await authorizeVoiceTransportConnection(token, context, deps);
    expect(second).toEqual({ ok: false, reason: 'replayed' });
  });

  it('a replay rejection releases the concurrency slot it had provisionally taken (no leaked slot from a rejected attempt)', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    await authorizeVoiceTransportConnection(token, context, deps); // first: succeeds, occupies 1 of 2 slots
    await authorizeVoiceTransportConnection(token, context, deps); // second: replay, must not leak a slot
    expect(deps.streamLimiter.activeCount(claims.kioskId)).toBe(1);
  });

  it('rejects once the kiosk is already at its concurrent-stream limit', async () => {
    const single = { ...deps, maxConcurrentStreamsPerKiosk: 1 };
    const { token: tokenA } = await issueVoiceTransportToken({ ...claims, jti: 'jti-a' });
    const { token: tokenB } = await issueVoiceTransportToken({ ...claims, jti: 'jti-b' });
    const first = await authorizeVoiceTransportConnection(tokenA, context, single);
    expect(first.ok).toBe(true);
    const second = await authorizeVoiceTransportConnection(tokenB, context, single);
    expect(second).toEqual({ ok: false, reason: 'concurrency_limit' });
  });

  it('an expired token is rejected as invalid_token (expiry enforced by token.ts, surfaced uniformly here)', async () => {
    const past = Date.now() - 10 * 60_000;
    const { token } = await issueVoiceTransportToken(claims, 60_000, past);
    expect(await authorizeVoiceTransportConnection(token, context, deps)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });
});
