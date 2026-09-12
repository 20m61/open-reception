import { beforeEach, describe, expect, it } from 'vitest';
import { issueVoiceTransportToken } from '@/lib/voice-transport/token';
import { createInMemoryReplayGuard } from '@/lib/voice-transport/replay-guard';
import { createInMemoryStreamLimiter } from '@/lib/voice-transport/stream-limiter';
import {
  acceptVoiceTransportGatewayConnection,
  parseVoiceTransportProtocolHeader,
  VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX,
  VOICE_TRANSPORT_MAX_AUDIO_FRAME_BYTES,
  VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES,
  VOICE_TRANSPORT_WS_PROTOCOL,
  type VoiceTransportGatewayAdmissionState,
  type VoiceTransportGatewayDeps,
} from './voice-gateway';

const runtimeScope = { tenantId: 'tenant-1', siteId: 'site-1' };
const claims = {
  tenantId: runtimeScope.tenantId,
  siteId: runtimeScope.siteId,
  kioskId: 'kiosk-1',
  receptionSessionId: 'reception-1',
  jti: 'jti-1',
};

function requestTarget(kioskId = claims.kioskId, receptionSessionId = claims.receptionSessionId): string {
  return `/v1/voice?kioskId=${encodeURIComponent(kioskId)}&receptionSessionId=${encodeURIComponent(receptionSessionId)}`;
}

function protocolHeader(token: string): string {
  return `${VOICE_TRANSPORT_WS_PROTOCOL}, ${VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX}${token}`;
}

function makeDeps() {
  let admission: VoiceTransportGatewayAdmissionState = 'ready';
  const deps: VoiceTransportGatewayDeps = {
    replayGuard: createInMemoryReplayGuard(),
    streamLimiter: createInMemoryStreamLimiter(),
    maxConcurrentStreamsPerKiosk: 1,
    admissionState: () => admission,
  };
  return {
    deps,
    setAdmission(next: VoiceTransportGatewayAdmissionState) {
      admission = next;
    },
  };
}

describe('Realtime voice gateway accept boundary', () => {
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    fixture = makeDeps();
  });

  it('accepts a correctly-scoped fresh token and echoes only the stable protocol', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const result = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocol).toBe(VOICE_TRANSPORT_WS_PROTOCOL);
    expect(result.protocol).not.toContain(token);
    expect(result.session.claims).toEqual(claims);
    expect(fixture.deps.streamLimiter.activeCount(claims.kioskId)).toBe(1);
  });

  it('uses runtime tenant/site as authority and rejects a token for another site', async () => {
    const { token } = await issueVoiceTransportToken({ ...claims, siteId: 'site-other' });
    const result = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );

    expect(result).toEqual({ ok: false, status: 403, reason: 'site_mismatch' });
  });

  it('rejects kiosk/reception routing context that does not match the signed claims', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const wrongKiosk = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget('kiosk-other'), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(wrongKiosk).toEqual({ ok: false, status: 403, reason: 'kiosk_mismatch' });
  });

  it('rejects unknown/duplicate query parameters so credentials cannot silently migrate into URLs', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const unknown = await acceptVoiceTransportGatewayConnection(
      {
        requestTarget: `${requestTarget()}&token=${encodeURIComponent(token)}`,
        protocolHeader: protocolHeader(token),
        runtimeScope,
      },
      fixture.deps,
    );
    expect(unknown).toEqual({ ok: false, status: 400, reason: 'invalid_request_context' });

    const duplicate = await acceptVoiceTransportGatewayConnection(
      {
        requestTarget: `${requestTarget()}&kioskId=${claims.kioskId}`,
        protocolHeader: protocolHeader(token),
        runtimeScope,
      },
      fixture.deps,
    );
    expect(duplicate).toEqual({ ok: false, status: 400, reason: 'invalid_request_context' });
  });

  it('rejects malformed protocol sets without reflecting the credential', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const malformed = parseVoiceTransportProtocolHeader(`${VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX}${token}`);

    expect(malformed).toEqual({ ok: false, status: 401, reason: 'invalid_protocol' });
    expect(JSON.stringify(malformed)).not.toContain(token);
  });

  it('rejects not-ready/draining before consuming the token, allowing a later ready retry', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    fixture.setAdmission('not_ready');

    const first = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(first).toEqual({ ok: false, status: 503, reason: 'not_ready' });
    expect(fixture.deps.streamLimiter.activeCount(claims.kioskId)).toBe(0);

    fixture.setAdmission('ready');
    const second = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(second.ok).toBe(true);
  });

  it('rejects replay and concurrency overflow with stable, non-secret reasons', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const first = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(first.ok).toBe(true);

    const replay = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(replay).toEqual({ ok: false, status: 401, reason: 'replayed' });
    expect(JSON.stringify(replay)).not.toContain(token);

    const { token: tokenB } = await issueVoiceTransportToken({ ...claims, jti: 'jti-2' });
    const overflow = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(tokenB), runtimeScope },
      fixture.deps,
    );
    expect(overflow).toEqual({ ok: false, status: 429, reason: 'concurrency_limit' });
  });

  it('releases the concurrency slot exactly once when the real socket closes', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const accepted = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    expect(fixture.deps.streamLimiter.activeCount(claims.kioskId)).toBe(1);
    accepted.session.close();
    accepted.session.close();
    expect(fixture.deps.streamLimiter.activeCount(claims.kioskId)).toBe(0);

    const { token: nextToken } = await issueVoiceTransportToken({ ...claims, jti: 'jti-next' });
    const next = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(nextToken), runtimeScope },
      fixture.deps,
    );
    expect(next.ok).toBe(true);
  });

  it('classifies heartbeat/audio frames and rejects text, malformed and oversized frames', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const accepted = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const heartbeat = accepted.session.handleFrame(new Uint8Array([0]), true);
    expect(heartbeat.ok && heartbeat.kind).toBe('heartbeat');
    if (heartbeat.ok && heartbeat.kind === 'heartbeat') expect([...heartbeat.reply]).toEqual([0]);

    const audio = new Uint8Array(VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES);
    const audioResult = accepted.session.handleFrame(audio, true);
    expect(audioResult.ok && audioResult.kind).toBe('audio');

    expect(accepted.session.handleFrame(new Uint8Array(VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES), false)).toEqual({
      ok: false,
      reason: 'text_frame_not_allowed',
      closeCode: 1003,
    });
    expect(accepted.session.handleFrame(new Uint8Array(3), true)).toEqual({
      ok: false,
      reason: 'invalid_audio_frame',
      closeCode: 1007,
    });
    expect(accepted.session.handleFrame(new Uint8Array(VOICE_TRANSPORT_MAX_AUDIO_FRAME_BYTES + 2), true)).toEqual({
      ok: false,
      reason: 'frame_too_large',
      closeCode: 1009,
    });
  });

  it('rejects frames after session close', async () => {
    const { token } = await issueVoiceTransportToken(claims);
    const accepted = await acceptVoiceTransportGatewayConnection(
      { requestTarget: requestTarget(), protocolHeader: protocolHeader(token), runtimeScope },
      fixture.deps,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    accepted.session.close();
    expect(accepted.session.handleFrame(new Uint8Array([0]), true)).toEqual({
      ok: false,
      reason: 'session_closed',
      closeCode: 1008,
    });
  });
});
