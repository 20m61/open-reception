import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claims = {
  tenantId: 'tenant-1',
  siteId: 'site-1',
  kioskId: 'kiosk-1',
  receptionSessionId: 'reception-1',
  jti: 'jti-1',
};

describe('voice-transport token issue/read', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.VOICE_TRANSPORT_TOKEN_SECRET;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });
  afterEach(() => {
    delete process.env.VOICE_TRANSPORT_TOKEN_SECRET;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  it('round-trips claims through issue -> read', async () => {
    const { issueVoiceTransportToken, readVoiceTransportToken } = await import('./token');
    const { token, expiresAt } = await issueVoiceTransportToken(claims);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const read = await readVoiceTransportToken(token);
    expect(read).toEqual(claims);
  });

  it('rejects an expired token', async () => {
    const { issueVoiceTransportToken, readVoiceTransportToken, DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS } = await import(
      './token'
    );
    const past = Date.now() - DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS - 60_000;
    const { token } = await issueVoiceTransportToken(claims, DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS, past);
    expect(await readVoiceTransportToken(token)).toBeNull();
  });

  it('rejects garbage input without throwing', async () => {
    const { readVoiceTransportToken } = await import('./token');
    await expect(readVoiceTransportToken('not-a-token')).resolves.toBeNull();
    await expect(readVoiceTransportToken(undefined)).resolves.toBeNull();
  });

  it('rejects a tampered token', async () => {
    const { issueVoiceTransportToken, readVoiceTransportToken } = await import('./token');
    const { token } = await issueVoiceTransportToken(claims);
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(await readVoiceTransportToken(tampered)).toBeNull();
  });

  it('rejects a token signed with a different secret (tamper detection via env)', async () => {
    const { issueVoiceTransportToken } = await import('./token');
    const { token } = await issueVoiceTransportToken(claims);

    vi.resetModules();
    process.env.VOICE_TRANSPORT_TOKEN_SECRET = 'a-completely-different-secret';
    const { readVoiceTransportToken } = await import('./token');
    await expect(readVoiceTransportToken(token)).resolves.toBeNull();
  });

  it('rejects a token issued for a different role (e.g. kiosk enrollment token reused here)', async () => {
    const { getVoiceTransportTokenSecret, readVoiceTransportToken } = await import('./token');
    const { signSession } = await import('../auth/session');
    const forged = await signSession(
      { role: 'kiosk-enroll', exp: Date.now() + 60_000, ...claims },
      getVoiceTransportTokenSecret(),
    );
    await expect(readVoiceTransportToken(forged)).resolves.toBeNull();
  });

  it('rejects claims missing a required field', async () => {
    const { getVoiceTransportTokenSecret, readVoiceTransportToken, VOICE_TRANSPORT_TOKEN_ROLE } = await import(
      './token'
    );
    const { signSession } = await import('../auth/session');
    const forged = await signSession(
      {
        role: VOICE_TRANSPORT_TOKEN_ROLE,
        exp: Date.now() + 60_000,
        tenantId: claims.tenantId,
        siteId: claims.siteId,
        kioskId: claims.kioskId,
        jti: claims.jti,
        // receptionSessionId 欠落
      },
      getVoiceTransportTokenSecret(),
    );
    await expect(readVoiceTransportToken(forged)).resolves.toBeNull();
  });

  it('fails closed (throws) when issuing in a deployed runtime without the secret set', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'voice-transport-fn';
    const { issueVoiceTransportToken } = await import('./token');
    await expect(issueVoiceTransportToken(claims)).rejects.toThrow();
  });
});
