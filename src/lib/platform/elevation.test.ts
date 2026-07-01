import { afterEach, describe, expect, it } from 'vitest';
import { grantElevation } from '@/domain/auth/elevation';
import { issueElevationToken, readElevation } from './elevation';
import { reauthenticate } from './reauth';

describe('elevation cookie (#83 inc4b)', () => {
  it('issue → read で昇格を往復復元する', async () => {
    const elevation = grantElevation({ reason: '障害調査のため設定変更', scope: { tenantId: 't1' } }, Date.now());
    const token = await issueElevationToken(elevation, 'jti-1');
    const read = await readElevation(token);
    expect(read).not.toBeNull();
    expect(read?.reason).toBe('障害調査のため設定変更');
    expect(read?.scope).toEqual({ tenantId: 't1', siteId: undefined, deviceId: undefined });
    expect(read?.until).toBe(elevation.until);
  });

  it('署名改ざん・空トークンは null', async () => {
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j');
    expect(await readElevation(`${token}tamper`)).toBeNull();
    expect(await readElevation(undefined)).toBeNull();
    expect(await readElevation('not.a.token')).toBeNull();
  });

  it('失効済み（until 過去）は null（verifySession の期限検証）', async () => {
    // until を過去にするため、grant 済みトークンの発行時刻を過去に置く。
    const past = grantElevation({ reason: 'x', scope: {} }, Date.now() - 2 * 60 * 60 * 1000); // 2h 前 grant → 30分TTL は既に失効
    const token = await issueElevationToken(past, 'j');
    expect(await readElevation(token)).toBeNull();
  });
});

describe('reauthenticate (#83 inc4b・mock)', () => {
  const prev = process.env.PLATFORM_REAUTH_MOCK;
  afterEach(() => {
    if (prev === undefined) delete process.env.PLATFORM_REAUTH_MOCK;
    else process.env.PLATFORM_REAUTH_MOCK = prev;
  });

  it('mock 未設定なら unsupported（本番想定・昇格不可）', async () => {
    delete process.env.PLATFORM_REAUTH_MOCK;
    expect(await reauthenticate('none', 'anything')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('mock 設定時は厳密一致のみ成功', async () => {
    process.env.PLATFORM_REAUTH_MOCK = 'secret-otp';
    expect(await reauthenticate('none', 'secret-otp')).toEqual({ ok: true });
    expect(await reauthenticate('none', 'wrong')).toEqual({ ok: false, reason: 'invalid_credential' });
  });

  it('cognito は #65 まで unsupported', async () => {
    process.env.PLATFORM_REAUTH_MOCK = 'x';
    expect(await reauthenticate('cognito', 'x')).toEqual({ ok: false, reason: 'unsupported' });
  });
});
