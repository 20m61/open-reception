/**
 * Negative security tests (spec §7)。
 *
 * 🔴 **破壊系を実試行しない。** 「AccessDenied を期待して DeleteTable を実行する」テストは、
 * Deny が効いていなかった場合に**本当に消す**。副作用の無い操作だけ実試行し、
 * 破壊系は `iam:SimulatePrincipalPolicy` で判定する。
 *
 * `scripts/aws-cloud-deploy.sh preflight` が呼ぶ。**1 件でも期待外れなら非ゼロで終わる**
 * （判定不能も期待外れとして扱う。`--strict` の思想: 測れていないものを PASS にしない）。
 *
 * 判定（stderr の分類 / PASS 集計）は `src/domain/governance/negative-test-outcome.ts`
 * の純関数に委ねる。ここは AWS CLI を呼んで結果を渡すだけの薄い I/O 層で、
 * このファイル自体はテストしない（AWS 認証情報が無いと動かないため）。
 */
import { execFileSync } from 'node:child_process';
import {
  classifyAwsError,
  classifySimulationError,
  findUnsuppliedPrincipals,
  resolveExecutionScope,
  resolvePrincipalArn,
  summarizeNegativeTests,
  type NegativeTestResult,
  type Outcome,
  type PrincipalArnMap,
  type SimulationPrincipal,
} from '../src/domain/governance/negative-test-outcome';

const ACCOUNT = '822063948773';

type Check = { readonly id: string; readonly description: string; readonly expected: Exclude<Outcome, 'unknown'> };

/**
 * 実試行する（副作用なし）。
 *
 * 🔴 **Important B（2026-08-12 レビュー）: 副作用の無さを個別に確認する。**
 * ここに置いてよいのは「呼んでも状態を変えない」操作だけ。各エントリの副作用有無:
 *
 * - N1/N2/N3（`sts:assume-role`）: 成功すると一時クレデンシャル（AccessKeyId /
 *   SecretAccessKey / SessionToken）が返る。`aws()` は `execFileSync` の戻り値
 *   （stdout の内容）を**変数に代入せず捨てている**ため、クレデンシャルはどこにも
 *   ログ出力・保存・送信されない（`console.log`/`console.error` は check の
 *   id/description/結果ラベルしか出さない）。子プロセスの stdout として一時的に
 *   Node 側のバッファへ載った後、関数を抜けると同時に GC 対象になる。呼び出し自体は
 *   AWS 側に何のリソースも作らない（`AssumeRole` は既存ロールの一時的な権限委譲であり、
 *   IAM オブジェクトを新規作成しない）。**この後段でその一時クレデンシャルを使って
 *   何かを実行することは一切無い。**
 * - N4/N5/N6（`cloudformation describe-stacks`）: 読み取り専用。
 * - N7（`secretsmanager list-secrets --max-results 1`）: シークレットの**メタデータ**
 *   （名前・ARN 等）だけを列挙する読み取り専用 API。値は取得しない
 *   （`GetSecretValue` ではない）。
 *
 * **N8（`iam:create-access-key`）はここに置いてはいけなかった。** Deny が効いていない
 * 場合（＝この検査が検出しようとしているまさにそのケース）、
 * `AdministratorAccess` 相当の principal 上に**本物の長期 access key を実際に発行して
 * しまう**。鍵 ID の記録も破棄の仕組みも無いため、検査を実行するたびに使われない
 * 長期クレデンシャルが account に残り得る。ファイル冒頭の「破壊系を実試行しない」
 * 原則そのものへの違反であり、spec §7 の表が N8 として分類していたのは誤りだった
 * （Task 7 で spec 側を修正すること）。`SIMULATED_CHECKS` の `S11` へ移動した。
 */
const LIVE_CHECKS: ReadonlyArray<Check & { readonly run: () => Outcome }> = [
  {
    id: 'N1',
    description: '専用 bootstrap (orcloud01) の deploy role を assume',
    expected: 'allowed',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-deploy-role-${ACCOUNT}-ap-northeast-1`),
  },
  {
    id: 'N2',
    description: '共有 bootstrap (hnb659fds) の deploy role を assume',
    expected: 'denied',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-ap-northeast-1`),
  },
  {
    id: 'N3',
    description: '共有 bootstrap (staging) の deploy role を assume',
    expected: 'denied',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-staging-deploy-role-${ACCOUNT}-ap-northeast-1`),
  },
  {
    id: 'N4',
    description: 'OpenReception-Web-dev を describe',
    expected: 'allowed',
    run: () => describeStack('OpenReception-Web-dev'),
  },
  { id: 'N5', description: 'nodi-dev-app を describe', expected: 'denied', run: () => describeStack('nodi-dev-app') },
  {
    id: 'N6',
    description: 'salon-loop-staging-data を describe',
    expected: 'denied',
    run: () => describeStack('salon-loop-staging-data'),
  },
  {
    id: 'N7',
    description: 'Secrets Manager の列挙',
    expected: 'denied',
    run: () => aws(['secretsmanager', 'list-secrets', '--max-results', '1']),
  },
  // N8 は欠番（旧 `iam:CreateAccessKey`。副作用があるため `SIMULATED_CHECKS` の S11 へ移動）。
  {
    // 🔴 **Critical 1（2026-08-12 全体レビュー）: lookup role は「読み取り専用の無害な
    // ロール」ではない。** `cdk bootstrap` のテンプレート
    // （`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml:495-506`）は
    // lookup role に AWS 管理ポリシー `ReadOnlyAccess` を付け、インラインで拒否するのは
    // `kms:Decrypt` **だけ**である。さらに `--custom-permissions-boundary` が boundary を
    // 付けるのは cfn-exec role **1 つだけ**（同ファイル 740 行目）なので、lookup role には
    // boundary も付かない。entry role がこれを assume できると、窓が開いている間に
    // nodi / salon-loop の DynamoDB・S3・Lambda 環境変数・Cognito ユーザーを
    // アカウント全体で読めてしまう ―― 主境界（層 1・3）を完全に迂回する。
    //
    // dev は context provider を一切使わない（`infra/` の `fromLookup` は
    // `web-stack.ts` の `HostedZone.fromLookup` 1 箇所のみで、`customDomain.createDnsRecord`
    // が真のときだけ実行される。dev は `-c customDomain=` を渡さない）ため、
    // lookup role は allowlist から外し、明示 Deny も重ねてある。
    id: 'N9',
    description: '専用 bootstrap (orcloud01) の lookup role を assume（ReadOnlyAccess 経由の迂回）',
    expected: 'denied',
    run: () => assumeRole(`arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-lookup-role-${ACCOUNT}-ap-northeast-1`),
  },
];

/**
 * 実試行しない。`SimulatePrincipalPolicy` で判定する（人間の Admin 環境から実行）。
 *
 * 🔴 **CRITICAL 3（2026-08-12 全体レビュー）: 各 check は「どの principal に対して
 * 評価するか」を明示する。**
 *
 * 旧実装は principal ARN を 1 本だけ受け取り、既定を entry role
 * （`OpenReceptionClaudeDeploy-dev`）にしていた。runbook ステップ 4a もその ARN を渡していた。
 * entry role は `DenyEverythingElseOutsideTheChain` で 4 アクション以外を最初から
 * 全 Deny するので、**S1〜S11 は `claude-boundary.json` / `claude-cfn-exec.json` が
 * そもそも作られていなくても全部 `denied` を返す** ―― 落ちようのない検査だった。
 * 本来 S4/S5/S7（boundary 脱出）・S6（PassRole）・S1/S3/S10 が問うているのは
 * `cdk-orcloud01-cfn-exec-role-*` の権限であり、その principal はこのブランチで
 * 一度もシミュレートされていなかった。
 *
 * `principals` は配列にしてある。同じ問いが**層をまたいで**二重に守られている場合
 * （例: foreign stack への操作は deploy role の層 1 と cfn-exec role の層 3 の両方で
 * Deny されるはず）、どちらか一方を選ぶのは恣意的で、片方の退行を見逃す。
 * 各 principal ごとに 1 件として採点する。
 */
type SimulatedCheck = {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
  readonly principals: ReadonlyArray<SimulationPrincipal>;
  /** どの層／どのステートメントを問うているか（結果の読み手向け）。 */
  readonly guards: string;
};

const SIMULATED_CHECKS: ReadonlyArray<SimulatedCheck> = [
  {
    id: 'S1',
    action: 'dynamodb:DeleteTable',
    resource: `arn:aws:dynamodb:ap-northeast-1:${ACCOUNT}:table/nodi-dev-anything`,
    principals: ['exec'],
    guards: '層 3 DenyForeignProjectData',
  },
  {
    id: 'S2',
    action: 'cloudformation:DeleteStack',
    resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/nodi-dev-app/*`,
    principals: ['deploy', 'exec'],
    guards: '層 1 DenyCloudFormationOutsideDevStacks / 層 3 DenyForeignProjectStacks',
  },
  {
    id: 'S3',
    action: 'secretsmanager:GetSecretValue',
    resource: `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:salon-loop/*`,
    principals: ['exec'],
    guards: '層 3 DenySecretsDnsAndPrincipals（T8 の全面 Deny）',
  },
  {
    id: 'S4',
    action: 'iam:CreateRole',
    resource: `arn:aws:iam::${ACCOUNT}:role/any-new-role`,
    principals: ['exec'],
    guards: '層 4 DenyRoleCreationWithoutBoundary（boundary 指定なしの呼び出し）',
  },
  {
    id: 'S5',
    action: 'iam:AttachRolePolicy',
    resource: `arn:aws:iam::${ACCOUNT}:role/any-role`,
    principals: ['exec'],
    guards: '層 4 DenyRoleCreationWithoutBoundary',
  },
  {
    id: 'S6',
    action: 'iam:PassRole',
    resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-ap-northeast-1`,
    principals: ['deploy', 'exec'],
    guards: '層 1 DenyPassingSharedExecRoles / 層 3 DenySharedBootstrapRoles',
  },
  {
    id: 'S7',
    action: 'iam:DeleteRolePermissionsBoundary',
    resource: `arn:aws:iam::${ACCOUNT}:role/any-role`,
    principals: ['exec'],
    guards: '層 4 DenyBoundaryEscape',
  },
  {
    id: 'S8',
    action: 'route53:ChangeResourceRecordSets',
    resource: 'arn:aws:route53:::hostedzone/ANY',
    principals: ['exec'],
    guards: '層 3 DenySecretsDnsAndPrincipals（T9）',
  },
  {
    id: 'S9',
    action: 'cloudformation:UpdateStack',
    resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/OpenReception-Web-prod/*`,
    principals: ['deploy', 'exec'],
    guards: '層 1・3 の OpenReception-*-prod Deny（T2）',
  },
  {
    id: 'S10',
    action: 'kms:ScheduleKeyDeletion',
    resource: `arn:aws:kms:ap-northeast-1:${ACCOUNT}:key/any`,
    principals: ['exec'],
    guards: '層 4 DenySecretsAndKeyDestruction',
  },
  // 旧 N8（Important B で live check から移動）。長期 access key を実際に発行しかねない
  // ため、実試行せず SimulatePrincipalPolicy で判定する。
  {
    id: 'S11',
    action: 'iam:CreateAccessKey',
    resource: `arn:aws:iam::${ACCOUNT}:user/CDK`,
    principals: ['entry', 'exec'],
    guards: 'entry の DenyEverythingElseOutsideTheChain / 層 4 DenyPrincipalCreationAndOrgChanges',
  },
  // Critical 1（同レビュー）: lookup role は ReadOnlyAccess 付き・boundary 無し。
  // live check N9 と対になる simulate 版。
  {
    id: 'S12',
    action: 'sts:AssumeRole',
    resource: `arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-lookup-role-${ACCOUNT}-ap-northeast-1`,
    principals: ['entry'],
    guards: 'entry の DenyBootstrapLookupRole（Critical 1）',
  },
  // Important 5（同レビュー）: 自分のチェーンから層 1 のインラインポリシーを剥がせないこと。
  {
    id: 'S13',
    action: 'iam:DeleteRolePolicy',
    resource: `arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-deploy-role-${ACCOUNT}-ap-northeast-1`,
    principals: ['exec'],
    guards: '層 3 DenyIamWriteOnForeignPrincipals（自分のチェーンを含む。Important 5）',
  },
  {
    id: 'S14',
    action: 'iam:CreatePolicyVersion',
    resource: `arn:aws:iam::${ACCOUNT}:policy/SalonLoopStagingCfnExecution`,
    principals: ['exec'],
    guards: '層 3 DenyIamWriteOnForeignPrincipals（他プロジェクトのポリシー。Important 5）',
  },
];

/** 環境変数名 → principal。**既定値は持たない**（Critical 3）。 */
const PRINCIPAL_ENV_VARS: Readonly<Record<SimulationPrincipal, string>> = {
  entry: 'SIMULATE_ENTRY_ROLE_ARN',
  deploy: 'SIMULATE_DEPLOY_ROLE_ARN',
  exec: 'SIMULATE_EXEC_ROLE_ARN',
};

/**
 * 🔴 **stderr を診断に載せる。** `execFileSync` の例外は `message` がコマンド行までで、
 * 理由は `stderr` にある。載せないと 3 周にわたって当て推量で直すことになる（2026-08-08 の実例）。
 *
 * ここで実行するのは**評価対象の操作そのもの**（N1〜N7。旧 N8 は Important B で
 * `SIMULATED_CHECKS` の `S11` へ移動済み）。だから `classifyAwsError` を
 * 使ってよい ―― この呼び出しへの AccessDenied は、まさにその操作が denied だったことを
 * 意味する。`simulate()`（別の API を呼ぶ）と混同しないこと。
 */
/**
 * 🔴 **VITEST 実行中は絶対に AWS へ到達しない。**
 *
 * `scripts/aws-cloud-deploy.sh` の `collect_observation` と同じインターロック。
 * `tests/hooks/aws-negative-tests-source.test.ts` はこの CLI を**実際に起動して**
 * 引数・環境変数の検証（principal 未供給なら実行拒否）を確かめる。検証が退行して
 * `aws` 呼び出しまで到達した場合でも、周囲の環境に本物の資格情報が残っていれば
 * 実 API を叩いてしまう ―― 過去に実際 STS へ到達した事故がある。
 * 「1 つの分岐だけがネットワークとの間に立つ」状態を避けるため、テストランタイムで
 * あること自体をここで検知して落とす。**exit code 3 はインターロック専用**
 * （2 = 引数エラー、1 = 検査 FAIL と区別する）。
 */
function refuseUnderTestRuntime(what: string): void {
  if (process.env.VITEST) {
    console.error(`  ⛔ VITEST 実行中のため AWS を呼びません（テストの安全装置）: ${what}`);
    process.exit(3);
  }
}

function aws(args: ReadonlyArray<string>): Outcome {
  refuseUnderTestRuntime(`aws ${args.slice(0, 2).join(' ')}`);
  try {
    execFileSync('aws', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'allowed';
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    const outcome = classifyAwsError(stderr);
    if (outcome === 'unknown') {
      console.error(`      (判定不能) ${stderr.trim().split('\n')[0] || '(stderr 空)'}`);
    }
    return outcome;
  }
}

const assumeRole = (arn: string): Outcome =>
  aws(['sts', 'assume-role', '--role-arn', arn, '--role-session-name', 'negative-test']);

const describeStack = (name: string): Outcome =>
  aws(['cloudformation', 'describe-stacks', '--stack-name', name]);

/**
 * `iam:SimulatePrincipalPolicy` **という別の API** を呼んで評価する。
 *
 * 🔴 **CRITICAL: catch で `classifyAwsError` を呼ばない。** この呼び出し自体への
 * AccessDenied は「`SimulatePrincipalPolicy` を呼ぶ権限が無かった」ことしか意味せず、
 * 評価対象アクション（`action`/`resource`）が denied かどうかには何も語らない。
 * `classifyAwsError` を使うと、principal が `iam:SimulatePrincipalPolicy` を持たない
 * だけで S1〜S10 が軒並み「denied（＝PASS）」に見えてしまう
 * （2026-08-12 レビューで検出。詳細は `classifySimulationError` のコメント参照）。
 * 常に `classifySimulationError` を使い、`'unknown'` として扱う。
 */
function simulate(principalArn: string, action: string, resource: string): Outcome {
  refuseUnderTestRuntime(`iam simulate-principal-policy (${action})`);
  try {
    const out = execFileSync(
      'aws',
      [
        'iam', 'simulate-principal-policy',
        '--policy-source-arn', principalArn,
        '--action-names', action,
        '--resource-arns', resource,
        '--query', 'EvaluationResults[0].EvalDecision',
        '--output', 'text',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (out === 'allowed') return 'allowed';
    if (out.endsWith('Deny')) return 'denied';
    console.error(`      (判定不能) EvalDecision=${out || '(空)'}`);
    return 'unknown';
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    const outcome = classifySimulationError(stderr);
    console.error(`      (判定不能: SimulatePrincipalPolicy 自体を呼べなかった) ${stderr.trim().split('\n')[0] || '(stderr 空)'}`);
    return outcome;
  }
}

/**
 * `--live-only`: S 系（`SimulatePrincipalPolicy`）をスキップする。
 * `scripts/aws-cloud-deploy.sh` の `collect_observation` が常にこのフラグ付きで呼ぶ
 * （`OpenReceptionClaudeDeploy-dev` は `iam:SimulatePrincipalPolicy` を持たない前提のため。
 * S 系は人間が Admin 環境の runbook で別途実施する。Important 5b）。
 *
 * `--simulate-only`: 逆に S 系だけを実行する（人間が Admin 環境から使う）。
 *
 * 両方の同時指定は矛盾するので `resolveExecutionScope` が `null` を返し、非ゼロで終わる。
 */
function main(): void {
  const simulateOnly = process.argv.includes('--simulate-only');
  const liveOnly = process.argv.includes('--live-only');
  const scope = resolveExecutionScope(simulateOnly, liveOnly);
  if (scope === null) {
    console.error('  ⛔ --simulate-only と --live-only は同時に指定できません');
    process.exit(2);
  }

  // 🔴 **旧変数を黙って無視しない。** `SIMULATE_PRINCIPAL_ARN` は「1 本の ARN を全 check に
  // 使う」という Critical 3 そのものの形。設定されたまま新実装を走らせると、runbook や
  // 手癖が古いままであることに誰も気づけない。明示的に止める。
  if (process.env.SIMULATE_PRINCIPAL_ARN !== undefined) {
    console.error(
      '  ⛔ SIMULATE_PRINCIPAL_ARN は廃止されました（1 本の ARN で全 S 系を評価すると、' +
        'entry role に対して boundary 脱出を聞くことになり検査が常に PASS します）。' +
        `代わりに ${Object.values(PRINCIPAL_ENV_VARS).join(' / ')} を設定してください。`,
    );
    process.exit(2);
  }

  const results: NegativeTestResult[] = [];

  if (scope !== 'simulate') {
    console.log('  実試行（副作用なし・caller の資格情報そのものを評価）:');
    for (const check of LIVE_CHECKS) {
      const actual = check.run();
      results.push({ id: check.id, expected: check.expected, actual });
      const pass = actual === check.expected;
      console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.description} → ${actual}（期待 ${check.expected}）`);
    }
  }

  if (scope !== 'live') {
    const arns: PrincipalArnMap = {
      entry: process.env[PRINCIPAL_ENV_VARS.entry],
      deploy: process.env[PRINCIPAL_ENV_VARS.deploy],
      exec: process.env[PRINCIPAL_ENV_VARS.exec],
    };
    const required = SIMULATED_CHECKS.flatMap((c) => c.principals);
    const missing = findUnsuppliedPrincipals(required, arns);
    // 🔴 **供給されていない principal があれば実行しない。** 既定値で埋めると
    // 「どのロールを検査したのか」が呼び出し側から見えなくなり、Critical 3 が再演する。
    if (missing.length > 0) {
      console.error('  ⛔ S 系の評価に必要な principal ARN が供給されていません:');
      for (const p of missing) {
        console.error(`    - ${p}: 環境変数 ${PRINCIPAL_ENV_VARS[p]} を設定してください`);
      }
      console.error('    （docs/runbook-cloud-aws-deploy.md ステップ 4a を参照）');
      process.exit(2);
    }

    console.log('  シミュレーション（破壊系は実試行しない）:');
    for (const check of SIMULATED_CHECKS) {
      for (const principal of check.principals) {
        const arn = resolvePrincipalArn(principal, arns);
        // `missing` チェックを通っているのでここには来ないが、型を絞るために残す。
        if (arn === null) continue;
        const actual = simulate(arn, check.action, check.resource);
        results.push({
          id: `${check.id}[${principal}]`,
          expected: 'denied',
          actual,
          requiredPrincipalArn: arn,
          evaluatedPrincipalArn: arn,
        });
        const pass = actual === 'denied';
        // 🔴 **principal を結果と同じ行に出す。** どのロールを検査したのかを読み手が
        // 取り違えられないようにする（Critical 3 の再演防止は型だけでは足りない）。
        console.log(
          `    ${pass ? '✅' : '❌'} ${check.id} [${principal}] ${check.action} → ${actual}（期待 denied）\n` +
            `        principal=${arn}\n` +
            `        guards=${check.guards}`,
        );
      }
    }
  } else {
    console.log('  シミュレーション（S 系）はスキップします（--live-only）。人間が Admin 環境の runbook で別途実施してください。');
  }

  // 🔴 **実行範囲を明示する。** live-only で走らせた結果を「全件 PASS」と読み違えると、
  // S 系（破壊系）が一度も評価されていないのに評価済みだと誤認する。
  const scopeLabel =
    scope === 'live'
      ? 'live のみ（S 系は未実施・人間の Admin runbook で別途実施すること）'
      : scope === 'simulate'
        ? 'simulate のみ（N 系は未実施）'
        : 'live + simulate（全件）';

  const { failed, misdirected } = summarizeNegativeTests(results);
  if (failed > 0) {
    console.error(`  ⛔ negative security test: ${failed} 件が期待どおりでない（実行範囲: ${scopeLabel}）`);
    if (misdirected > 0) {
      console.error(`     うち ${misdirected} 件は意図しない principal に対する評価のため棄却（採点していない）`);
    }
    process.exit(1);
  }
  console.log(`  ✅ negative security test PASS（実行範囲: ${scopeLabel}）`);
}

main();
