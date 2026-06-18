import { beforeAll, describe, expect, it } from 'vitest';
import { verifyEntraToken, type Jwk, type JwkResolver } from './entra';
import type { AdminRole } from '@/domain/auth/roles';

/**
 * Entra JWT 検証の単体テスト (issue #70)。
 * ローカルで RSA 鍵を生成して RS256 JWT を署名し、ネットワーク無しで検証経路を網羅する。
 */
const KID = 'test-key-1';
const ISSUER = 'https://login.microsoftonline.com/tenant-1/v2.0';
const AUDIENCE = 'api://client-1';
const ALL: Set<AdminRole> = new Set(['Admin', 'SiteManager', 'Viewer']);

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

let privateKey: CryptoKey;
let publicJwk: Jwk;
let resolver: JwkResolver;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID };
  resolver = async (kid) => (kid === KID ? publicJwk : null);
});

async function makeToken(payload: Record<string, unknown>, opts?: { kid?: string; alg?: string }): Promise<string> {
  const header = b64urlJson({ alg: opts?.alg ?? 'RS256', kid: opts?.kid ?? KID, typ: 'JWT' });
  const body = b64urlJson(payload);
  const signing = new TextEncoder().encode(`${header}.${body}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signing);
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const validPayload = () => ({
  iss: ISSUER,
  aud: AUDIENCE,
  exp: Math.floor(Date.now() / 1000) + 3600,
  oid: 'user-oid-1',
  preferred_username: 'admin@example.com',
  roles: ['OpenReception.Admin'],
});

const baseOpts = () => ({ issuer: ISSUER, audience: AUDIENCE, allowedRoles: ALL, getKey: resolver });

describe('verifyEntraToken (#70)', () => {
  it('正当なトークンを検証しロール/識別子を返す', async () => {
    const token = await makeToken(validPayload());
    const r = await verifyEntraToken(token, baseOpts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBe('Admin');
      expect(r.subject).toBe('user-oid-1');
      expect(r.email).toBe('admin@example.com');
    }
  });

  it('署名改ざんを拒否する', async () => {
    const token = await makeToken(validPayload());
    const tampered = token.slice(0, -4) + 'AAAA';
    const r = await verifyEntraToken(tampered, baseOpts());
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('issuer 不一致を拒否する', async () => {
    const token = await makeToken({ ...validPayload(), iss: 'https://evil/v2.0' });
    expect((await verifyEntraToken(token, baseOpts())).ok).toBe(false);
  });

  it('audience 不一致を拒否する', async () => {
    const token = await makeToken({ ...validPayload(), aud: 'api://other' });
    expect((await verifyEntraToken(token, baseOpts())).ok).toBe(false);
  });

  it('期限切れを拒否する', async () => {
    const token = await makeToken({ ...validPayload(), exp: Math.floor(Date.now() / 1000) - 3600 });
    const r = await verifyEntraToken(token, baseOpts());
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('管理ロールが無いトークンを拒否する', async () => {
    const token = await makeToken({ ...validPayload(), roles: ['SomethingElse'] });
    const r = await verifyEntraToken(token, baseOpts());
    expect(r).toEqual({ ok: false, reason: 'no_admin_role' });
  });

  it('許可外ロールを拒否する（allowedRoles 制限）', async () => {
    const token = await makeToken({ ...validPayload(), roles: ['Viewer'] });
    const r = await verifyEntraToken(token, { ...baseOpts(), allowedRoles: new Set<AdminRole>(['Admin']) });
    expect(r).toEqual({ ok: false, reason: 'role_not_allowed' });
  });

  it('未知の kid を拒否する', async () => {
    const token = await makeToken(validPayload(), { kid: 'unknown-kid' });
    const r = await verifyEntraToken(token, baseOpts());
    expect(r).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it('RS256 以外のアルゴリズムを拒否する', async () => {
    const token = await makeToken(validPayload(), { alg: 'none' });
    const r = await verifyEntraToken(token, baseOpts());
    expect(r).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('壊れたトークン形式を拒否する', async () => {
    expect((await verifyEntraToken('not-a-jwt', baseOpts())).ok).toBe(false);
  });
});
