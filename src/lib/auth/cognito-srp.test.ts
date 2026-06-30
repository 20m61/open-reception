import { describe, it, expect, vi, beforeEach } from 'vitest';

// SRP の暗号計算（cognito-srp-helper）は AWS 公式系ライブラリに委譲しているため、ここでは
// **オーケストレーション**（2 段フロー・ChallengeName 分岐・エラー写像）のみを検証する。
// ライブラリと SDK を mock し、自前ロジックを切り出してテストする。
vi.mock('cognito-srp-helper', () => ({
  createSrpSession: vi.fn(() => ({ srp: 'session' })),
  signSrpSession: vi.fn(() => ({ srp: 'signed' })),
  wrapInitiateAuth: vi.fn((_s: unknown, req: unknown) => req),
  wrapAuthChallenge: vi.fn((_s: unknown, req: unknown) => req),
}));

const send = vi.fn();
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    send = send;
  },
  InitiateAuthCommand: class {
    constructor(public input: unknown) {}
  },
  RespondToAuthChallengeCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { cognitoSrpLogin } from './cognito-srp';

const params = { region: 'ap-northeast-1', userPoolId: 'ap-northeast-1_pool', clientId: 'client123' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cognitoSrpLogin', () => {
  it('PASSWORD_VERIFIER → トークン取得で ok（2 段フロー）', async () => {
    send
      .mockResolvedValueOnce({ ChallengeName: 'PASSWORD_VERIFIER', ChallengeParameters: {} })
      .mockResolvedValueOnce({ AuthenticationResult: { IdToken: 'id.jwt.token', AccessToken: 'a', RefreshToken: 'r' } });
    const r = await cognitoSrpLogin('user', 'pass', params);
    expect(r).toEqual({ ok: true, idToken: 'id.jwt.token', accessToken: 'a', refreshToken: 'r' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('PASSWORD_VERIFIER 以外のチャレンジ（MFA 等）は challenge_required', async () => {
    send.mockResolvedValueOnce({ ChallengeName: 'SMS_MFA' });
    const r = await cognitoSrpLogin('user', 'pass', params);
    expect(r).toEqual({ ok: false, reason: 'challenge_required' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('RespondToAuthChallenge が更にチャレンジを返すと challenge_required', async () => {
    send
      .mockResolvedValueOnce({ ChallengeName: 'PASSWORD_VERIFIER' })
      .mockResolvedValueOnce({ ChallengeName: 'NEW_PASSWORD_REQUIRED' });
    expect(await cognitoSrpLogin('user', 'pass', params)).toEqual({ ok: false, reason: 'challenge_required' });
  });

  it('NotAuthorizedException は invalid_credentials', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'NotAuthorizedException' }));
    expect(await cognitoSrpLogin('user', 'bad', params)).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('UserNotFoundException は invalid_credentials', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'UserNotFoundException' }));
    expect(await cognitoSrpLogin('ghost', 'x', params)).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('その他の例外は error', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    expect(await cognitoSrpLogin('user', 'pass', params)).toEqual({ ok: false, reason: 'error' });
  });

  it('IdToken 欠落は error', async () => {
    send
      .mockResolvedValueOnce({ ChallengeName: 'PASSWORD_VERIFIER' })
      .mockResolvedValueOnce({ AuthenticationResult: {} });
    expect(await cognitoSrpLogin('user', 'pass', params)).toEqual({ ok: false, reason: 'error' });
  });
});
