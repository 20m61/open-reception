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
  /**
   * 🔴 **`/session/create` へ form で送る**（2026-09-02 仕様照合）。以前の
   * `/v2/project/{appId}/session` + JSON `{ mediaMode }` は存在しない経路で、実資格情報を
   * 入れた瞬間に 404 になるはずだった。公式 SDK（Node / Python / Java）と同じ要求に揃える。
   */
  it('POSTs form-encoded to /session/create with a Bearer app JWT and parses session_id', async () => {
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
    expect(url).toBe('https://video.test/session/create');
    expect(init.method).toBe('POST');
    const auth = init.headers.Authorization ?? '';
    expect(auth).toMatch(/^Bearer .+\..+\..+$/);
    // Bearer の JWT は app 認証（application_id を含む）。
    const jwt = auth.slice('Bearer '.length);
    expect(decodeJwtPayload(jwt).application_id).toBe('app-123');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // 無いと XML で返る。
    expect(init.headers.Accept).toBe('application/json');
    // REST の項目名は `p2p.preference`（`disabled` = routed）。`mediaMode` は SDK 側の呼び名。
    const form = new URLSearchParams(init.body!);
    expect(form.get('p2p.preference')).toBe('disabled');
    expect(form.get('archiveMode')).toBe('manual');
    expect(form.has('mediaMode')).toBe(false);
  });

  it('applicationId を URL に載せない（REST は JWT の application_id で識別する）', async () => {
    let seen = '';
    const transport: VonageTransport = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => JSON.stringify([{ session_id: 's' }]) };
    };
    await new RestVonageSessionService(config, transport, 'https://video.test').createSession('r');
    expect(seen).not.toContain('app-123');
    expect(seen).not.toContain('/v2/project/');
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

  it('throws a clear error on a non-JSON 200 body', async () => {
    const transport: VonageTransport = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>oops</html>',
    });
    const svc = new RestVonageSessionService(config, transport);
    await expect(svc.createSession('r')).rejects.toThrow(/invalid JSON response/);
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
  it('returns calling with the created sessionId (awaiting answer)', async () => {
    const adapter = new VonageCallAdapter(config, {
      createSession: async () => ({ sessionId: 'sess-1' }),
      issueToken: async (s, role) => ({ token: 't', role, expiresAt: new Date().toISOString() }),
    });
    const result = await adapter.call({ receptionId: 'rec-1', targetType: 'staff', targetId: 'staff-1' });
    expect(result.status).toBe('calling');
    expect(result.sessionId).toBe('sess-1');
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
