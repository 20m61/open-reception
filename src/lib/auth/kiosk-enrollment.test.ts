import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENROLLMENT_TTL_MS,
  ENROLLMENT_ROLE,
  issueEnrollmentToken,
  newEnrollmentJti,
  readEnrollmentToken,
} from './kiosk-enrollment';
import { signSession } from './session';
import { getEnrollmentSecret } from './kiosk-enrollment';

const claims = {
  tenantId: 'internal',
  siteId: 'default-site',
  deviceId: 'kiosk-dev',
  jti: 'jti-123',
};

describe('kiosk-enrollment token', () => {
  it('発行→検証で同じクレームを復元する', async () => {
    const { token, expiresAt } = await issueEnrollmentToken(claims);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const read = await readEnrollmentToken(token);
    expect(read).toEqual(claims);
  });

  it('exp 切れトークンは null', async () => {
    // now を過去に固定し、TTL を足しても現在時刻より前にする。
    const past = Date.now() - DEFAULT_ENROLLMENT_TTL_MS - 60_000;
    const { token } = await issueEnrollmentToken(claims, DEFAULT_ENROLLMENT_TTL_MS, past);
    expect(await readEnrollmentToken(token)).toBeNull();
  });

  it('改ざんトークンは null', async () => {
    const { token } = await issueEnrollmentToken(claims);
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(await readEnrollmentToken(tampered)).toBeNull();
  });

  it('role 不一致（kiosk セッション等）は null', async () => {
    const exp = Date.now() + DEFAULT_ENROLLMENT_TTL_MS;
    const wrongRole = await signSession({ role: 'kiosk', exp, ...claims }, getEnrollmentSecret());
    expect(await readEnrollmentToken(wrongRole)).toBeNull();
  });

  it('必須クレーム欠落は null', async () => {
    const exp = Date.now() + DEFAULT_ENROLLMENT_TTL_MS;
    const missing = await signSession(
      { role: ENROLLMENT_ROLE, exp, tenantId: 'internal', siteId: 'default-site', deviceId: 'kiosk-dev' },
      getEnrollmentSecret(),
    );
    expect(await readEnrollmentToken(missing)).toBeNull();
  });

  it('undefined トークンは null', async () => {
    expect(await readEnrollmentToken(undefined)).toBeNull();
  });

  it('jti は呼ぶたびに異なる', () => {
    expect(newEnrollmentJti()).not.toBe(newEnrollmentJti());
  });
});
