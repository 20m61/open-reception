import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantBreakGlass, grantElevation } from '@/domain/auth/elevation';
import { issueElevationToken, readElevation } from './elevation';
import { elevationJtiState, __resetElevationJtis } from './elevation-jti-store';
import { reauthenticate } from './reauth';

beforeEach(async () => {
  await __resetElevationJtis();
});

describe('elevation cookie (#83 inc4b)', () => {
  it('issue → read で昇格を往復復元する', async () => {
    const elevation = grantElevation({ reason: '障害調査のため設定変更', scope: { tenantId: 't1' } }, Date.now());
    const token = await issueElevationToken(elevation, 'jti-1', 'dev@example.com');
    const read = await readElevation(token);
    expect(read).not.toBeNull();
    expect(read?.reason).toBe('障害調査のため設定変更');
    expect(read?.scope).toEqual({ tenantId: 't1', siteId: undefined, deviceId: undefined });
    expect(read?.until).toBe(elevation.until);
    expect(read?.sub).toBe('dev@example.com'); // 操作者 identity を復元（#264）。
    expect(read?.jti).toBe('jti-1'); // 失効チェック用に jti も復元（#264）。
  });

  it('issue は jti を失効ストアへ登録する（#264: 発行 = 記録。fail-closed の前提）', async () => {
    const elevation = grantElevation({ reason: 'x', scope: {} }, Date.now());
    await issueElevationToken(elevation, 'jti-reg', 'dev@example.com');
    expect(await elevationJtiState('jti-reg', Date.now())).toBe('active');
  });

  it('jti 欠落の cookie は無効＝null（失効追跡できないトークンを流通させない）', async () => {
    const { signSession } = await import('@/lib/auth/session');
    const noJti = await signSession(
      { role: 'platform_elevation', exp: Date.now() + 60_000, reason: 'x', scope: {}, sub: 'dev@example.com' },
      'dev-insecure-elevation-secret',
    );
    expect(await readElevation(noJti)).toBeNull();
  });

  it('sub 欠落の cookie は無効＝null（#264 前の cookie で platform:unknown を出さない）', async () => {
    const { signSession } = await import('@/lib/auth/session');
    const noSub = await signSession(
      { role: 'platform_elevation', exp: Date.now() + 60_000, reason: 'x', scope: {}, jti: 'j' },
      'dev-insecure-elevation-secret',
    );
    expect(await readElevation(noSub)).toBeNull();
  });

  it('署名改ざん・空トークンは null', async () => {
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j', 'dev@example.com');
    expect(await readElevation(`${token}tamper`)).toBeNull();
    expect(await readElevation(undefined)).toBeNull();
    expect(await readElevation('not.a.token')).toBeNull();
  });

  it('break-glass 昇格は breakGlass:true を往復復元する（#83 §3）', async () => {
    const token = await issueElevationToken(grantBreakGlass({ reason: '緊急対応', scope: {} }, Date.now()), 'j-bg', 'dev@example.com');
    const read = await readElevation(token);
    expect(read?.breakGlass).toBe(true);
  });

  it('breakGlass の無い既存クレームは非 break-glass として復元する（後方互換, #83 §3）', async () => {
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j-std', 'dev@example.com');
    const read = await readElevation(token);
    expect(read?.breakGlass).toBeUndefined();
  });

  it('失効済み（until 過去）は null（verifySession の期限検証）', async () => {
    // until を過去にするため、grant 済みトークンの発行時刻を過去に置く。
    const past = grantElevation({ reason: 'x', scope: {} }, Date.now() - 2 * 60 * 60 * 1000); // 2h 前 grant → 30分TTL は既に失効
    const token = await issueElevationToken(past, 'j', 'dev@example.com');
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
