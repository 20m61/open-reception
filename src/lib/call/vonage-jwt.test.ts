/**
 * vonage-jwt の単体テスト。
 * テスト用 RSA キーペアを生成し、生成 JWT が公開鍵で検証でき、claims/有効期限が正しいことを確認する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  decodeJwtPayload,
  generateAppJwt,
  generateClientToken,
  signRs256,
} from './vonage-jwt';

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeyPem = privateKey;
  publicKeyPem = publicKey;
});

function verify(jwt: string): boolean {
  const [h, p, s] = jwt.split('.');
  const sig = Buffer.from(s!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return createVerify('RSA-SHA256').update(`${h}.${p}`).end().verify(publicKeyPem, sig);
}

describe('signRs256', () => {
  it('produces a header.payload.signature verifiable with the public key', () => {
    const jwt = signRs256({ foo: 'bar' }, privateKeyPem);
    expect(jwt.split('.')).toHaveLength(3);
    expect(verify(jwt)).toBe(true);

    const header = JSON.parse(
      Buffer.from(jwt.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    );
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeJwtPayload(jwt)).toEqual({ foo: 'bar' });
  });

  it('fails verification if the payload is tampered', () => {
    const jwt = signRs256({ foo: 'bar' }, privateKeyPem);
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ foo: 'evil' })).toString('base64url')}.${s}`;
    expect(verify(forged)).toBe(false);
  });
});

describe('generateAppJwt', () => {
  it('includes application_id/iat/exp/jti and is signature-valid', () => {
    const jwt = generateAppJwt({
      applicationId: 'app-123',
      privateKeyPem,
      nowSec: 1_000_000,
      ttlSec: 120,
    });
    expect(verify(jwt)).toBe(true);
    const p = decodeJwtPayload(jwt);
    expect(p.application_id).toBe('app-123');
    expect(p.iat).toBe(1_000_000);
    expect(p.exp).toBe(1_000_120);
    expect(typeof p.jti).toBe('string');
  });

  it('issues unique jti per call', () => {
    const a = decodeJwtPayload(generateAppJwt({ applicationId: 'x', privateKeyPem }));
    const b = decodeJwtPayload(generateAppJwt({ applicationId: 'x', privateKeyPem }));
    expect(a.jti).not.toBe(b.jti);
  });
});

describe('generateClientToken', () => {
  it('produces a session.connect token with role and expiry metadata', () => {
    const result = generateClientToken({
      applicationId: 'app-123',
      privateKeyPem,
      sessionId: 'sess-abc',
      role: 'publisher',
      nowSec: 2_000_000,
      ttlSec: 300,
    });
    expect(verify(result.token)).toBe(true);
    expect(result.role).toBe('publisher');
    expect(result.expiresAt).toBe(new Date(2_000_300 * 1000).toISOString());

    const p = decodeJwtPayload(result.token);
    expect(p.application_id).toBe('app-123');
    expect(p.scope).toBe('session.connect');
    expect(p.session_id).toBe('sess-abc');
    expect(p.role).toBe('publisher');
    expect(p.iat).toBe(2_000_000);
    expect(p.exp).toBe(2_000_300);
  });

  it('defaults to a short TTL when not specified', () => {
    const result = generateClientToken({
      applicationId: 'a',
      privateKeyPem,
      sessionId: 's',
      role: 'subscriber',
      nowSec: 0,
    });
    const p = decodeJwtPayload(result.token);
    expect(p.exp).toBe(300); // DEFAULT_TOKEN_TTL_SEC
  });
});
