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
 *
 * ## 🔴 このファイルのテスト被覆には穴がある（既知・意図的に残している）
 *
 * 判定と合成は `emulator-capability.ts` の純関数へ全部出してあり、そちらは unit で
 * 縛られている。**ここに残っているのは「効果をどう配線するか」だけ**である。
 * ゲートはこのファイルを**一度も実行しない**（エミュレータが要るため）ので、
 * 次の型の誤りは**どのテストでも落ちない**:
 *
 * - 負の対照に**正しい**パスワードを渡す（`loginWithWrongPassword` の引数間違い）
 * - closure の中で真偽を反転する / 固定値を返す
 * - 測定を `results` に入れ忘れる / `probes` から 1 行消す / 集計前に `filter` する
 * - **判定の「効果」を落とす**: exit code を握り潰す / 表示記号を `verdict` から導出せず
 *   固定する / 実 AWS guard を warn へ落とす。レビュー round4 が実測しており、
 *   いずれも「🔴 素通り と印字しながら exit 0」「permissive を ✅ と印字」まで行く。
 *
 * - 🔴 **判定に渡す測定値そのものを偽る**: 測定不能を `positive: 'failed'` として組み立てる
 *   （`inconclusive` ではなく `unavailable` になり、**exit 0 で ⛔ を印字する**）、
 *   `probes` から 1 行消す、集計へ渡す前に `filter` する。判定関数は設計どおり呼ばれ、
 *   **嘘の入力を渡されるだけ**なので、純関数側の守りは一切効かない。
 *
 * - 🔴 **負の対照を、正の対照と「別の対象」へ向ける**（空のコレクション・別のキー）。
 *   測定は本物なので `rejected` が返り、**✅ verified が出る** ―― 5 つの型の中で最も静かで
 *   最も危険である。SRP 経路は `combineNegativeOutcomes` が「正の対照が通っていなければ
 *   `rejected` を信用しない」ことで部分的に守るが、**boolean 経路には同等の結合が無い**
 *   （`negativeFromBooleanProbe` は `true` を無条件に `rejected` へ写す）。round5 が
 *   `measureTenantIsolation` の負の対照を空コレクションへ向けて実測し、出力は
 *   **byte 単位で同一**だった。
 *
 * レビュー（#1103 round3 / round5 / round6）がこれらの生存を実測している。塞ぐには probe を
 * **既知の振る舞いを持つ fake クライアント**に対して実行するしかなく、それは
 * 現時点では割に合わないと判断した（#1112 で再考の余地あり）。
 * **このファイルを編集するときは、`npm run aws:local:capability` を両 runtime で
 * 実際に走らせて出力を目で確かめること。** 静的検査は二次的な網でしかない。
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
  CAPABILITY_CONTROLS,
  PROBE_CAPABILITIES,
  type ProbeCapability,
} from '../src/domain/governance/capability-doc';
import {
  classifyCapability,
  matrixMark,
  measureBooleanCapability,
  measureSrpCapability,
  summarizeMeasurements,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from '../src/domain/governance/emulator-capability';
import { awsClientConfig } from '../src/lib/aws/client-config';

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = 'TEST-Capability-Passw0rd!';

type Measurement = {
  readonly capability: ProbeCapability;
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
  // 🔴 **能力名は測定関数自身が持つ。** 呼び出し側から渡させると、対応表のキーと値が
  // ずれたときに誰も気づけない（レビュー実測: `Record` のキーと値を入れ替えても
  // typecheck 緑・テスト緑で、次の記録が中身の入れ替わったものになる）。
  const capability: ProbeCapability = 'Cognito USER_SRP_AUTH（管理者ログイン）';
  const { positiveDesc, negativeDesc } = CAPABILITY_CONTROLS[capability];
  // 🔴 endpoint / 資格情報を手で書かない。`awsClientConfig()` を通すことで
  // 実資格情報の混入は `resolveAwsRuntimeConfig` が fail-fast する（ADR 0010）。
  const cip = new CognitoIdentityProviderClient(awsClientConfig(undefined, { region: REGION }));
  let userPoolId: string | undefined;
  try {
    const { cognitoSrpLogin } = await import('../src/lib/auth/cognito-srp');
    const username = `cap-admin-${RUN}`;
    const pool = await cip.send(new CreateUserPoolCommand({ PoolName: `cap-${RUN}` }));
    const poolId = pool.UserPool?.Id;
    if (!poolId) throw new Error('no user pool id');
    userPoolId = poolId;
    const created = await cip.send(
      new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: `cap-${RUN}`,
        GenerateSecret: false,
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      }),
    );
    const clientId = created.UserPoolClient?.ClientId;
    if (!clientId) throw new Error('no client id');
    await cip.send(
      new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS' }),
    );
    await cip.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: username,
        Password: PASSWORD,
        Permanent: true,
      }),
    );

    const params = { region: REGION, userPoolId: poolId, clientId };
    // 🔴 判定も合成も**持たない**。効果だけ渡す（レビュー round3 MAJOR-2）。
    const { positive, negative, verdict } = await measureSrpCapability({
      loginWithCorrectPassword: () => cognitoSrpLogin(username, PASSWORD, params, cip),
      loginWithWrongPassword: () => cognitoSrpLogin(username, `WRONG-${PASSWORD}`, params, cip),
      loginWithWrongPasswordAlternateShape: () =>
        wrongPasswordWithPlainUsername(cip, username, poolId, clientId),
    });
    return {
      capability,
      positiveDesc,
      negativeDesc,
      positive,
      negative,
      verdict,
      note:
        positive === 'passed'
          ? undefined
          : '正の対照が本番の呼び方で通らなかった' +
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
  const capability: ProbeCapability = 'DynamoDB 条件付き作成（putIfAbsent の原子性）';
  const { positiveDesc, negativeDesc } = CAPABILITY_CONTROLS[capability];
  const { DynamoBackend } = await import('../src/lib/data/dynamodb');
  const col = new DynamoBackend().collection<{ id: string; tenantId: string }>(`cap-cond-${RUN}`, {
    indexedField: 'tenantId',
  });
  const measured = await measureBooleanCapability({
    runPositive: () => ran(() => col.putIfAbsent({ id: 'dup', tenantId: `t-${RUN}` })),
    // 二重作成が「拒否された」= putIfAbsent が false を返した。
    runNegative: async () => {
      const again = await ran(() => col.putIfAbsent({ id: 'dup', tenantId: `t-${RUN}` }));
      return again === 'threw' ? 'threw' : !again;
    },
  });
  await ran(async () => {
    await col.remove('dup');
    return true;
  });
  return { capability, positiveDesc, negativeDesc, ...measured };
}

/** DynamoDB テナント分離: 正 = 自テナントは引ける / 負 = 他テナントからは引けない。 */
async function measureTenantIsolation(): Promise<Measurement> {
  const capability: ProbeCapability = 'DynamoDB GSI テナント分離';
  const { positiveDesc, negativeDesc } = CAPABILITY_CONTROLS[capability];
  const { DynamoBackend } = await import('../src/lib/data/dynamodb');
  const col = new DynamoBackend().collection<{ id: string; tenantId: string }>(`cap-tenant-${RUN}`, {
    indexedField: 'tenantId',
  });
  const mine = `tenant-mine-${RUN}`;
  const theirs = `tenant-theirs-${RUN}`;
  const measured = await measureBooleanCapability({
    runPositive: () =>
      ran(async () => {
        await col.put({ id: 'a', tenantId: mine });
        return (await col.listByIndex(mine)).some((v) => v.id === 'a');
      }),
    runNegative: () => ran(async () => (await col.listByIndex(theirs)).length === 0),
  });
  await ran(async () => {
    await col.remove('a');
    return true;
  });
  return { capability, positiveDesc, negativeDesc, ...measured };
}

async function main() {
  const json = process.argv.includes('--json');
  // 🔴 このスクリプトは**リソースを作る**（Cognito user pool / ユーザー / DynamoDB 項目）。
  // 実 AWS を向いたまま走らせない。レーン外から直叩きされたときの最後の砦。
  const { resolveAwsRuntimeConfig } = await import('../src/domain/governance/aws-runtime');
  const resolved = resolveAwsRuntimeConfig(process.env);
  if (!resolved.emulated) {
    console.error(
      'capability probe はエミュレータ専用です（リソースを作るため）。' +
        'AWS_RUNTIME=ministack|moto|localstack を指定するか `npm run aws:local:capability` を使ってください。',
    );
    process.exit(2);
  }
  // 🔴 1 つの測定が落ちても他の結果を捨てない（round3 M-ii: TABLE_NAME 異常で
  // 確定済みの permissive 記録ごと exit 2 になり、🔴 が消えていた）。
  // 🔴 **能力名は `PROBE_CAPABILITIES`（`capability-doc.ts`）が唯一の出どころ**である。
  // ここで綴りを変えると、記録済み JSON と文書の突き合わせ（#1113 /
  // `tests/config/capability-doc-sync.test.ts`）が**型で**落ちる ―― probe が能力を
  // 足した／消したのに表が追随しない、という型を機械で止めるため。
  // `Record<ProbeCapability, ...>` なので網羅も型が強制する。
  const runners: Readonly<Record<ProbeCapability, () => Promise<Measurement>>> = {
    // Cognito を先に測る（`PROBE_CAPABILITIES` の順序）。ここが素通りしていると、
    // 他が全部緑でも「ローカルで認証を検証できる」とは言えない。
    'Cognito USER_SRP_AUTH（管理者ログイン）': measureCognitoSrp,
    'DynamoDB 条件付き作成（putIfAbsent の原子性）': measureConditionalWrite,
    'DynamoDB GSI テナント分離': measureTenantIsolation,
  };
  const results: Measurement[] = [];
  for (const capability of PROBE_CAPABILITIES) {
    try {
      const measurement = await runners[capability]();
      // 🔴 **対応表のキーと、測定関数が名乗った能力が一致すること。** ずれていたら
      // 記録は「能力 A の名前で能力 B を測った結果」になる。静かに出荷しない。
      if (measurement.capability !== capability) {
        throw new Error(
          `測定関数の対応がずれている: ${capability} のはずが ${measurement.capability} を測った`,
        );
      }
      results.push(measurement);
    } catch (e) {
      results.push({
        capability,
        positiveDesc: '-',
        negativeDesc: '-',
        positive: 'unreachable',
        negative: 'unreachable',
        verdict: classifyCapability({ positive: 'unreachable', negative: 'unreachable' }),
        note: `測定が落ちた: ${(e as Error)?.message}`,
      });
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        { runtime: resolved.runtime, endpoint: resolved.endpoint ?? ENDPOINT, measuredAt: new Date().toISOString(), results },
        null,
        2,
      ),
    );
  } else {
    // 🔴 記録の値は**実際に解決された設定**から出す（round3 M-i: env の既定値を
    // そのまま出していたため `runtime=moto endpoint=…:4566` のような嘘の見出しが出ていた）。
    console.log(`\nruntime=${resolved.runtime} endpoint=${resolved.endpoint ?? ENDPOINT}\n`);
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
  const { code } = summarizeMeasurements(results.map((r) => r.verdict));

  if (permissive.length > 0) {
    console.error(
      `🔴 素通りしている能力が ${permissive.length} 件ある。ローカルの緑をその能力の根拠にしないこと:\n` +
        permissive.map((r) => `  - ${r.capability}`).join('\n'),
    );
  }
  // 🔴 **「測れなかった」で exit 0 を返さない。** エミュレータが上がっていないまま再測すると
  // 全部 ?/⛔ が並ぶ。これを成功として読むと、素通りの記録が静かに「安全な」判定へ
  // 格下げされる（レビュー round1 M2）。
  if (inconclusive.length > 0) {
    console.error(
      `⚠ 判定できなかった能力が ${inconclusive.length} 件ある（測定環境の問題であって、` +
        `「その能力が無い」ではない）。表を書き換える根拠にしないこと:\n` +
        inconclusive.map((r) => `  - ${r.capability}${r.note ? `: ${r.note}` : ''}`).join('\n'),
    );
  }
  if (code !== 0) process.exit(code);
}

main().catch((e) => {
  console.error('capability probe failed:', e);
  process.exit(2);
});
