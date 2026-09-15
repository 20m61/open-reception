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
} from '@aws-sdk/client-cognito-identity-provider';
import {
  classifyCapability,
  matrixMark,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from '../src/domain/governance/emulator-capability';

const RUNTIME = process.env.AWS_RUNTIME ?? 'ministack';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = 'Capability-Passw0rd!';

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
 * Cognito: 本番モジュール `cognitoSrpLogin` そのものを当てる。
 *
 * 正 = 正しいパスワードでトークンが出ること。
 * 負 = **誤ったパスワードが拒否されること**（ここが 2026-09-14 に落ちていた）。
 */
async function measureCognitoSrp(): Promise<Measurement> {
  const capability = 'Cognito USER_SRP_AUTH（管理者ログイン）';
  const positiveDesc = '正しいパスワードで ID トークンが出る';
  const negativeDesc = '🔴 誤ったパスワードが拒否される';
  const cip = new CognitoIdentityProviderClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
  try {
    const { cognitoSrpLogin } = await import('../src/lib/auth/cognito-srp');
    const username = `cap-admin-${RUN}`;
    const pool = await cip.send(new CreateUserPoolCommand({ PoolName: `cap-${RUN}` }));
    const userPoolId = pool.UserPool?.Id;
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
    await cip.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS' }));
    await cip.send(
      new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: PASSWORD, Permanent: true }),
    );

    const params = { region: REGION, userPoolId, clientId };
    const good = await cognitoSrpLogin(username, PASSWORD, params, cip);
    const bad = await cognitoSrpLogin(username, `WRONG-${PASSWORD}`, params, cip);

    const positive: PositiveOutcome = good.ok ? 'passed' : 'failed';
    const negative: NegativeOutcome = bad.ok ? 'accepted' : 'rejected';
    return {
      capability,
      positiveDesc,
      negativeDesc,
      positive,
      negative,
      verdict: classifyCapability({ positive, negative }),
      note: good.ok ? undefined : `正の対照が落ちた: ${good.reason}`,
    };
  } catch (e) {
    return {
      capability,
      positiveDesc,
      negativeDesc,
      positive: 'failed',
      negative: 'unreachable',
      verdict: classifyCapability({ positive: 'failed', negative: 'unreachable' }),
      note: `セットアップ不可: ${(e as Error)?.message}`,
    };
  } finally {
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
  const positive: PositiveOutcome = first === true ? 'passed' : 'failed';
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
  const positive: PositiveOutcome = positiveRan === true ? 'passed' : 'failed';
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
  if (permissive.length > 0) {
    console.error(
      `🔴 素通りしている能力が ${permissive.length} 件ある。ローカルの緑をその能力の根拠にしないこと:\n` +
        permissive.map((r) => `  - ${r.capability}`).join('\n'),
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('capability probe failed:', e);
  process.exit(2);
});
