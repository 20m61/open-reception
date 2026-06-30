import { describe, it, expect, vi, beforeEach } from 'vitest';

// SRP の暗号計算（cognito-srp-helper）は AWS 公式系ライブラリに委譲しているため、ここでは
// **オーケストレーション**（2 段フロー・ChallengeName 分岐・エラー写像）のみを検証する。
// ライブラリと SDK を mock し、自前ロジックを切り出してテストする。
const createSrpSession = vi.fn((..._a: unknown[]) => ({ srp: 'session' }));
vi.mock('cognito-srp-helper', () => ({
  createSrpSession: (...a: unknown[]) => createSrpSession(...a),
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
    // isHashed=false を必ず渡す（平文 PW を helper にハッシュさせる。true だと NotAuthorized）。
    expect(createSrpSession).toHaveBeenCalledWith('user', 'pass', params.userPoolId, false);
  });

  it('PASSWORD_VERIFIER 以外のチャレンジ（MFA 等）は challenge_required', async () => {
    send.mockResolvedValueOnce({ ChallengeName: 'SMS_MFA' });
    const r = await cognitoSrpLogin('user', 'pass', params);
    expect(r).toEqual({ ok: false, reason: 'challenge_required' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('NEW_PASSWORD_REQUIRED は password_change_required（汎用401に丸めない, #1）', async () => {
    send
      .mockResolvedValueOnce({ ChallengeName: 'PASSWORD_VERIFIER' })
      .mockResolvedValueOnce({ ChallengeName: 'NEW_PASSWORD_REQUIRED' });
    expect(await cognitoSrpLogin('user', 'pass', params)).toEqual({
      ok: false,
      reason: 'password_change_required',
    });
  });

  it('その他の二段チャレンジ（MFA 等）は challenge_required', async () => {
    send
      .mockResolvedValueOnce({ ChallengeName: 'PASSWORD_VERIFIER' })
      .mockResolvedValueOnce({ ChallengeName: 'SOFTWARE_TOKEN_MFA' });
    expect(await cognitoSrpLogin('user', 'pass', params)).toEqual({ ok: false, reason: 'challenge_required' });
  });

  it('ChallengeResponses.USERNAME に USER_ID_FOR_SRP を使う（エイリアスログイン対応, #2）', async () => {
    send
      .mockResolvedValueOnce({
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: { USER_ID_FOR_SRP: 'canonical-user' },
      })
      .mockResolvedValueOnce({ AuthenticationResult: { IdToken: 'id.jwt.token' } });
    await cognitoSrpLogin('user@example.com', 'pass', params);
    // 2 回目の send（RespondToAuthChallenge）の input を検査。
    const respondCmd = send.mock.calls[1]?.[0] as { input?: { ChallengeResponses?: { USERNAME?: string } } };
    expect(respondCmd?.input?.ChallengeResponses?.USERNAME).toBe('canonical-user');
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
