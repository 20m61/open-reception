/**
 * ローカル AWS エミュレータの能力を、**負の対照つきで**実測する（#1103 / ADR 0010）。
 *
 * ## なぜ要るか
 *
 * `docs/local-aws.md` の compatibility matrix は**散文**で、誰も機械で確かめていなかった。
 * 2026-09-14 に「Cognito user pool + SRP client ✅」と書かれていた行は、実際には
 * **誤ったパスワードでもトークンが出る**状態だった。表を作った当時の測り方が
 * 「操作が成功したか」だけを見ていたためである。
 *
 * このスクリプトは各能力に**正の対照**（通らなければならない）と**負の対照**
 * （拒否されなければならない）を組で当て、`classifyCapability()` に判定させる。
 * 判定と記号は `src/domain/governance/emulator-capability.ts` に一本化してあり、
 * ここは測るだけで、丸め方を持たない。
 *
 * ## 走らせ方
 *
 *     npm run aws:local:up
 *     npm run aws:local:capability                 # 既定 runtime
 *     AWS_RUNTIME=moto npm run aws:local:capability
 *
 * `--json` で機械可読出力。permissive が 1 つでもあれば **exit 1**
 * （🔴 素通りは「使える」ではない。既定で目に入らないと表がまた古びる）。
 *
 * 🔴 **これは品質ゲートに入れない。** エミュレータの稼働を前提にするため、
 * 既定のゲートは不変のままにする（#1103 条件 5）。
 */
import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  CreateUserPoolClientCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  DeleteUserPoolCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createSrpSession, signSrpSession, wrapInitiateAuth, wrapAuthChallenge } from 'cognito-srp-helper';
import {
  classifyCapability,
  matrixMark,
  negativeFromLoginResult,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from '../src/domain/governance/emulator-capability';
import { awsClientConfig } from '../src/lib/aws/client-config';

const RUNTIME = process.env.AWS_RUNTIME ?? 'ministack';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = 'TEST-Capability-Passw0rd!';

type Measurement = {
  readonly capability: string;
  readonly positiveDesc: string;
  readonly negativeDesc: string;
  readonly positive: PositiveOutcome;
  readonly negative: NegativeOutcome;
  readonly verdict: CapabilityVerdict;
  readonly note?: string;
};

/** 対照を 1 つ走らせる。例外は「通らなかった」に落とす（対照の意味は呼び出し側が持つ）。 */
async function ran(fn: () => Promise<boolean>): Promise<boolean | 'threw'> {
  try {
    return await fn();
  } catch {
    return 'threw';
  }
}


/**
 * 本番の呼び方（`ChallengeResponses.USERNAME` = `USER_ID_FOR_SRP`）で正の対照が通らない
 * エミュレータ向けの**代替の負の対照**。
 *
 * 🔴 **なぜ要るか。** Moto は本番の呼び方ではユーザーを解決できず、正の対照が落ちる。
 * それだけを見て `unavailable`（⛔＝「使えないが嘘はつかない」）と記録すると、
 * **平文 username へ変えれば誤った PW でもトークンが出る**事実を取り逃がす。
 * ハーネスを「動くように」直した人がそのまま素通りへ踏み込むので、ここで先に暴く。
 *
 * 誤ったパスワードで**トークンが出たら** `accepted`（素通り）。それ以外は判定しない。
 */
async function wrongPasswordWithPlainUsername(
  cip: CognitoIdentityProviderClient,
  username: string,
  userPoolId: string,
  clientId: string,
): Promise<NegativeOutcome> {
  try {
    const session = createSrpSession(username, `WRONG-${PASSWORD}`, userPoolId, false);
    const init = await cip.send(
      new InitiateAuthCommand(
        wrapInitiateAuth(session, {
          AuthFlow: 'USER_SRP_AUTH',
          ClientId: clientId,
          AuthParameters: { USERNAME: username },
        } as never),
      ),
    );
    if (init.ChallengeName !== 'PASSWORD_VERIFIER') return 'unreachable';
    const res = await cip.send(
      new RespondToAuthChallengeCommand(
        wrapAuthChallenge(signSrpSession(session, init), {
          ClientId: clientId,
          ChallengeName: 'PASSWORD_VERIFIER',
          ChallengeResponses: { USERNAME: username },
        } as never),
      ),
    );
    return res.AuthenticationResult?.IdToken ? 'accepted' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Cognito: 本番モジュール `cognitoSrpLogin` そのものを当てる。
 *
 * 正 = 正しいパスワードでトークンが出ること。
 * 負 = **誤ったパスワードが拒否されること**（ここが 2026-09-14 に落ちていた）。
 */
async function measureCognitoSrp(): Promise<Measurement> {
  const capability = 'Cognito USER_SRP_AUTH（管理者ログイン）';
  const positiveDesc = '正しいパスワードで ID トークンが出る';
  const negativeDesc = '🔴 誤ったパスワードが拒否される';
  // 🔴 endpoint / 資格情報を手で書かない。`awsClientConfig()` を通すことで
  // 実資格情報の混入は `resolveAwsRuntimeConfig` が fail-fast する（ADR 0010）。
  const cip = new CognitoIdentityProviderClient(awsClientConfig(undefined, { region: REGION }));
  let userPoolId: string | undefined;
  try {
    const { cognitoSrpLogin } = await import('../src/lib/auth/cognito-srp');
    const username = `cap-admin-${RUN}`;
    const pool = await cip.send(new CreateUserPoolCommand({ PoolName: `cap-${RUN}` }));
    userPoolId = pool.UserPool?.Id;
    if (!userPoolId) throw new Error('no user pool id');
    const created = await cip.send(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: `cap-${RUN}`,
        GenerateSecret: false,
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      }),
    );
    const clientId = created.UserPoolClient?.ClientId;
    if (!clientId) throw new Error('no client id');
    await cip.send(
      new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS' }),
    );
    await cip.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: PASSWORD,
        Permanent: true,
      }),
    );

    const params = { region: REGION, userPoolId, clientId };
    const good = await cognitoSrpLogin(username, PASSWORD, params, cip);
    const bad = await cognitoSrpLogin(username, `WRONG-${PASSWORD}`, params, cip);

    // 🔴 正の対照も「落ちた」と「走らせられなかった」を分ける。`error` は障害であって
    // 「この能力が無い」ではない。
    const positive: PositiveOutcome = good.ok
      ? 'passed'
      : good.reason === 'error'
        ? 'unreachable'
        : 'failed';
    // 🔴 `bad.ok ? 'accepted' : 'rejected'` と書かない（それが #1103 レビューの BLOCKER）。
    let negative: NegativeOutcome = negativeFromLoginResult(bad);
    // 本番の呼び方で正の対照が落ちたなら、素通りを見逃していないか別の呼び方で確かめる。
    if (positive !== 'passed' && negative !== 'accepted') {
      negative = await wrongPasswordWithPlainUsername(cip, username, userPoolId, clientId);
    }
    return {
      capability,
      positiveDesc,
      negativeDesc,
      positive,
      negative,
      verdict: classifyCapability({ positive, negative }),
      note: good.ok
        ? undefined
        : `正の対照が通らなかった: ${good.reason}` +
          (negative === 'accepted' ? '（ただし平文 username なら誤った PW でも通る＝素通り）' : ''),
    };
  } catch (e) {
    // セットアップ不能は「能力が無い」ではない。判定を下さない。
    return {
      capability,
      positiveDesc,
      negativeDesc,
      positive: 'unreachable',
      negative: 'unreachable',
      verdict: classifyCapability({ positive: 'unreachable', negative: 'unreachable' }),
      note: `セットアップ不可: ${(e as Error)?.message}`,
    };
  } finally {
    // 共有エミュレータに残骸を積まない。
    if (userPoolId) {
      await cip.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId })).catch(() => undefined);
    }
    cip.destroy();
  }
}

/** DynamoDB 条件付き作成: 正 = 新規は作れる / 負 = 重複は拒否される。 */
async function measureConditionalWrite(): Promise<Measurement> {
  const capability = 'DynamoDB 条件付き作成（putIfAbsent の原子性）';
  const positiveDesc = '新規 id の作成が成功する';
  const negativeDesc = '同じ id の二重作成が拒否される';
  const { DynamoBackend } = await import('../src/lib/data/dynamodb');
  const col = new DynamoBackend().collection<{ id: string; tenantId: string }>(`cap-cond-${RUN}`, {
    indexedField: 'tenantId',
  });
  const first = await ran(() => col.putIfAbsent({ id: 'dup', tenantId: `t-${RUN}` }));
  const second = await ran(() => col.putIfAbsent({ id: 'dup', tenantId: `t-${RUN}` }));
  const positive: PositiveOutcome = first === 'threw' ? 'unreachable' : first ? 'passed' : 'failed';
  const negative: NegativeOutcome =
    second === 'threw' ? 'unreachable' : second === false ? 'rejected' : 'accepted';
  return { capability, positiveDesc, negativeDesc, positive, negative, verdict: classifyCapability({ positive, negative }) };
}

/** DynamoDB テナント分離: 正 = 自テナントは引ける / 負 = 他テナントからは引けない。 */
async function measureTenantIsolation(): Promise<Measurement> {
  const capability = 'DynamoDB GSI テナント分離';
  const positiveDesc = '自テナントの項目が index 越しに引ける';
  const negativeDesc = '他テナントからは引けない';
  const { DynamoBackend } = await import('../src/lib/data/dynamodb');
  const col = new DynamoBackend().collection<{ id: string; tenantId: string }>(`cap-tenant-${RUN}`, {
    indexedField: 'tenantId',
  });
  const mine = `tenant-mine-${RUN}`;
  const theirs = `tenant-theirs-${RUN}`;
  const positiveRan = await ran(async () => {
    await col.put({ id: 'a', tenantId: mine });
    return (await col.listByIndex(mine)).some((v) => v.id === 'a');
  });
  const negativeRan = await ran(async () => (await col.listByIndex(theirs)).length === 0);
  const positive: PositiveOutcome =
    positiveRan === 'threw' ? 'unreachable' : positiveRan ? 'passed' : 'failed';
  const negative: NegativeOutcome =
    negativeRan === 'threw' ? 'unreachable' : negativeRan === true ? 'rejected' : 'accepted';
  return { capability, positiveDesc, negativeDesc, positive, negative, verdict: classifyCapability({ positive, negative }) };
}

async function main() {
  const json = process.argv.includes('--json');
  const results: Measurement[] = [];
  // Cognito を先に測る。ここが素通りしていると、他が全部緑でも
  // 「ローカルで認証を検証できる」とは言えない。
  results.push(await measureCognitoSrp());
  results.push(await measureConditionalWrite());
  results.push(await measureTenantIsolation());

  if (json) {
    console.log(JSON.stringify({ runtime: RUNTIME, endpoint: ENDPOINT, measuredAt: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(`\nruntime=${RUNTIME} endpoint=${ENDPOINT}\n`);
    for (const r of results) {
      console.log(`${matrixMark(r.verdict)}  ${r.capability}  [${r.verdict}]`);
      console.log(`      正: ${r.positiveDesc} -> ${r.positive}`);
      console.log(`      負: ${r.negativeDesc} -> ${r.negative}`);
      if (r.note) console.log(`      note: ${r.note}`);
    }
    console.log('');
  }

  const permissive = results.filter((r) => r.verdict === 'permissive');
  const inconclusive = results.filter((r) => r.verdict === 'inconclusive');

  if (permissive.length > 0) {
    console.error(
      `🔴 素通りしている能力が ${permissive.length} 件ある。ローカルの緑をその能力の根拠にしないこと:\n` +
        permissive.map((r) => `  - ${r.capability}`).join('\n'),
    );
    process.exit(1);
  }
  // 🔴 **「測れなかった」で exit 0 を返さない。** エミュレータが上がっていないまま再測すると
  // 全部 ⛔/? が並ぶ。これを成功として読むと、素通りの記録が静かに「安全な」判定へ
  // 格下げされる（#1103 レビュー指摘 M2）。
  if (inconclusive.length > 0) {
    console.error(
      `⚠ 判定できなかった能力が ${inconclusive.length} 件ある（測定環境の問題であって、` +
        `「その能力が無い」ではない）。表を書き換える根拠にしないこと:\n` +
        inconclusive.map((r) => `  - ${r.capability}${r.note ? `: ${r.note}` : ''}`).join('\n'),
    );
    process.exit(3);
  }
}

main().catch((e) => {
  console.error('capability probe failed:', e);
  process.exit(2);
});
