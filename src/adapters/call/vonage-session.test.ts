/**
 * RestVonageSessionService と VonageCallAdapter の単体テスト。
 * createSession は注入 transport を mock し、request 整形・認証ヘッダ・レスポンス解釈を検証する。
 * issueToken はローカル JWT 発行を検証する。実 Vonage への結合確認は別途（increment 1 は単体まで）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { RestVonageSessionService, type VonageTransport } from './vonage-session';
import { VonageCallAdapter } from './vonage';
import { decodeJwtPayload } from '@/lib/call/vonage-jwt';
import type { VonageConfig } from '@/lib/call/vonage-config';

let config: VonageConfig;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  config = {
    applicationId: 'app-123',
    apiKey: 'k',
    apiSecret: 's',
    privateKey,
  };
});

describe('RestVonageSessionService.createSession', () => {
  it('POSTs to the project session endpoint with a Bearer app JWT and parses session_id', async () => {
    const calls: Array<{ url: string; init: Parameters<VonageTransport>[1] }> = [];
    const transport: VonageTransport = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify([{ session_id: 'sess-abc' }]) };
    };
    const svc = new RestVonageSessionService(config, transport, 'https://video.test');

    const ref = await svc.createSession('rec-1');
    expect(ref.sessionId).toBe('sess-abc');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://video.test/v2/project/app-123/session');
    expect(init.method).toBe('POST');
    const auth = init.headers.Authorization ?? '';
    expect(auth).toMatch(/^Bearer .+\..+\..+$/);
    // Bearer の JWT は app 認証（application_id を含む）。
    const jwt = auth.slice('Bearer '.length);
    expect(decodeJwtPayload(jwt).application_id).toBe('app-123');
    expect(JSON.parse(init.body!)).toMatchObject({ mediaMode: 'routed' });
  });

  it('accepts a non-array response shape', async () => {
    const transport: VonageTransport = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session_id: 'sess-obj' }),
    });
    const svc = new RestVonageSessionService(config, transport);
    expect((await svc.createSession('r')).sessionId).toBe('sess-obj');
  });

  it('throws on non-ok HTTP status', async () => {
    const transport: VonageTransport = async () => ({ ok: false, status: 401, text: async () => 'no' });
    const svc = new RestVonageSessionService(config, transport);
    await expect(svc.createSession('r')).rejects.toThrow(/HTTP 401/);
  });

  it('throws when session_id is missing', async () => {
    const transport: VonageTransport = async () => ({ ok: true, status: 200, text: async () => '[]' });
    const svc = new RestVonageSessionService(config, transport);
    await expect(svc.createSession('r')).rejects.toThrow(/session_id missing/);
  });
});

describe('RestVonageSessionService.issueToken', () => {
  it('issues a session.connect JWT for the role', async () => {
    const svc = new RestVonageSessionService(config, async () => ({ ok: true, status: 200, text: async () => '[]' }));
    const tok = await svc.issueToken({ sessionId: 'sess-xyz' }, 'publisher');
    expect(tok.role).toBe('publisher');
    expect(Date.parse(tok.expiresAt)).toBeGreaterThan(0);
    const p = decodeJwtPayload(tok.token);
    expect(p.scope).toBe('session.connect');
    expect(p.session_id).toBe('sess-xyz');
    expect(p.role).toBe('publisher');
  });
});

describe('VonageCallAdapter', () => {
  it('returns connected after creating a session and issuing a token', async () => {
    const adapter = new VonageCallAdapter(config, {
      createSession: async () => ({ sessionId: 'sess-1' }),
      issueToken: async (s, role) => ({ token: 't', role, expiresAt: new Date().toISOString() }),
    });
    const result = await adapter.call({ receptionId: 'rec-1', targetType: 'staff', targetId: 'staff-1' });
    expect(result.status).toBe('connected');
  });

  it('returns failed with reason when session creation throws', async () => {
    const adapter = new VonageCallAdapter(config, {
      createSession: async () => {
        throw new Error('boom');
      },
      issueToken: async () => {
        throw new Error('unused');
      },
    });
    const result = await adapter.call({ receptionId: 'rec-1', targetType: 'staff', targetId: 'staff-1' });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('boom');
  });
});
