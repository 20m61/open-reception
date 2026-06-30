/**
 * Cognito 埋め込みログイン（USER_SRP_AUTH） (issue #238)。
 *
 * 自前 `/admin/login` フォームの username/password を受け、**SRP（Secure Remote Password）**で
 * 認証する。パスワードは Cognito へ**平文送信しない**（バックエンドが SRP 証明のみ送る）。
 * SRP 暗号は自前実装せず AWS 公式系 `cognito-srp-helper`（Apache-2.0）に委譲する。
 * Hosted UI へのリダイレクトは行わない。server-only。
 *
 * フロー: createSrpSession → InitiateAuth(USER_SRP_AUTH) → PASSWORD_VERIFIER チャレンジ →
 *         signSrpSession → RespondToAuthChallenge → ID/Access トークン。
 * App Client は client secret 無し（generateSecret:false）前提。
 */
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type InitiateAuthCommandInput,
  type RespondToAuthChallengeCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  createSrpSession,
  signSrpSession,
  wrapInitiateAuth,
  wrapAuthChallenge,
} from 'cognito-srp-helper';

export type CognitoSrpParams = { region: string; userPoolId: string; clientId: string };

export type SrpLoginResult =
  | { ok: true; idToken: string; accessToken?: string; refreshToken?: string }
  | { ok: false; reason: 'invalid_credentials' | 'challenge_required' | 'error' };

/**
 * SRP で Cognito 認証して ID トークンを得る。`client` はテスト注入用。
 * 資格情報誤りは `invalid_credentials`、MFA 等の追加チャレンジは `challenge_required`（inc1 非対応）。
 */
export async function cognitoSrpLogin(
  username: string,
  password: string,
  params: CognitoSrpParams,
  client?: CognitoIdentityProviderClient,
): Promise<SrpLoginResult> {
  const cip = client ?? new CognitoIdentityProviderClient({ region: params.region });
  try {
    // 第4引数 isHashed は **false 必須**。既定 true は「password が既に SHA-256 ハッシュ済み」を
    // 意味し、平文 PW を渡すと署名が不一致になり Cognito が NotAuthorized を返す（実機検証で判明）。
    const session = createSrpSession(username, password, params.userPoolId, false);

    const initiateInput = wrapInitiateAuth(session, {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: params.clientId,
      AuthParameters: { USERNAME: username },
    } as InitiateAuthCommandInput);
    const initRes = await cip.send(new InitiateAuthCommand(initiateInput));

    if (initRes.ChallengeName !== 'PASSWORD_VERIFIER') {
      return { ok: false, reason: 'challenge_required' };
    }

    const signed = signSrpSession(session, initRes);
    const challengeInput = wrapAuthChallenge(signed, {
      ClientId: params.clientId,
      ChallengeName: 'PASSWORD_VERIFIER',
      ChallengeResponses: { USERNAME: username },
    } as RespondToAuthChallengeCommandInput);
    const respRes = await cip.send(new RespondToAuthChallengeCommand(challengeInput));

    if (respRes.ChallengeName) return { ok: false, reason: 'challenge_required' };
    const idToken = respRes.AuthenticationResult?.IdToken;
    if (!idToken) return { ok: false, reason: 'error' };
    return {
      ok: true,
      idToken,
      accessToken: respRes.AuthenticationResult?.AccessToken,
      refreshToken: respRes.AuthenticationResult?.RefreshToken,
    };
  } catch (e) {
    const name = (e as { name?: string })?.name ?? '';
    if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
      return { ok: false, reason: 'invalid_credentials' };
    }
    return { ok: false, reason: 'error' };
  }
}
