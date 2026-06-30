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
  | { ok: false; reason: 'invalid_credentials' | 'password_change_required' | 'challenge_required' | 'error' };

/** region ごとに SDK client を再利用する（リクエスト毎生成を避ける, レビュー#8）。 */
const clientCache = new Map<string, CognitoIdentityProviderClient>();
function getClient(region: string): CognitoIdentityProviderClient {
  let c = clientCache.get(region);
  if (!c) {
    c = new CognitoIdentityProviderClient({ region });
    clientCache.set(region, c);
  }
  return c;
}

/**
 * SRP で Cognito 認証して ID トークンを得る。`client` はテスト注入用。
 * 資格情報誤りは `invalid_credentials`、初回パスワード変更要求は `password_change_required`、
 * その他の追加チャレンジ（MFA 等）は `challenge_required`（いずれも inc1 非対応）、
 * 一時障害（throttle/network 等）は `error`（呼び出し側で 503 に丸める）。
 */
export async function cognitoSrpLogin(
  username: string,
  password: string,
  params: CognitoSrpParams,
  client?: CognitoIdentityProviderClient,
): Promise<SrpLoginResult> {
  const cip = client ?? getClient(params.region);
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
    // ChallengeResponses.USERNAME は入力値ではなく **USER_ID_FOR_SRP** を使う（レビュー#2）。
    // email 等のエイリアスでログインした場合、Cognito の正規 username と異なり NotAuthorized になる。
    const userIdForSrp = initRes.ChallengeParameters?.USER_ID_FOR_SRP ?? username;
    const challengeInput = wrapAuthChallenge(signed, {
      ClientId: params.clientId,
      ChallengeName: 'PASSWORD_VERIFIER',
      ChallengeResponses: { USERNAME: userIdForSrp },
    } as RespondToAuthChallengeCommandInput);
    const respRes = await cip.send(new RespondToAuthChallengeCommand(challengeInput));

    if (respRes.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      // FORCE_CHANGE_PASSWORD ユーザー。inc1 ではフォームに変更導線が無いため明示的に区別する（レビュー#1）。
      return { ok: false, reason: 'password_change_required' };
    }
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
