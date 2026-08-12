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
import { classifyAwsError, summarizeNegativeTests, type Outcome } from '../src/domain/governance/negative-test-outcome';

const ACCOUNT = '822063948773';

type Check = { readonly id: string; readonly description: string; readonly expected: Exclude<Outcome, 'unknown'> };

/** 実試行する（副作用なし）。 */
const LIVE_CHECKS: ReadonlyArray<Check & { readonly run: () => Outcome }> = [
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
];

/** 実試行しない。`SimulatePrincipalPolicy` で判定する（人間の Admin 環境から実行）。 */
const SIMULATED_CHECKS: ReadonlyArray<{
  readonly id: string;
  readonly action: string;
  readonly resource: string;
}> = [
  { id: 'S1', action: 'dynamodb:DeleteTable', resource: `arn:aws:dynamodb:ap-northeast-1:${ACCOUNT}:table/nodi-dev-anything` },
  { id: 'S2', action: 'cloudformation:DeleteStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/nodi-dev-app/*` },
  { id: 'S3', action: 'secretsmanager:GetSecretValue', resource: `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:salon-loop/*` },
  { id: 'S5', action: 'iam:AttachRolePolicy', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S6', action: 'iam:PassRole', resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-ap-northeast-1` },
  { id: 'S7', action: 'iam:DeleteRolePermissionsBoundary', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S8', action: 'route53:ChangeResourceRecordSets', resource: 'arn:aws:route53:::hostedzone/ANY' },
  { id: 'S9', action: 'cloudformation:UpdateStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/OpenReception-Web-prod/*` },
  { id: 'S10', action: 'kms:ScheduleKeyDeletion', resource: `arn:aws:kms:ap-northeast-1:${ACCOUNT}:key/any` },
];

/**
 * 🔴 **stderr を診断に載せる。** `execFileSync` の例外は `message` がコマンド行までで、
 * 理由は `stderr` にある。載せないと 3 周にわたって当て推量で直すことになる（2026-08-08 の実例）。
 */
function aws(args: ReadonlyArray<string>): Outcome {
  try {
    execFileSync('aws', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'allowed';
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    const outcome = classifyAwsError(stderr);
    if (outcome === 'unknown') {
      console.error(`      (判定不能) ${stderr.trim().split('\n')[0] ?? '(stderr 空)'}`);
    }
    return outcome;
  }
}

const assumeRole = (arn: string): Outcome =>
  aws(['sts', 'assume-role', '--role-arn', arn, '--role-session-name', 'negative-test']);

const describeStack = (name: string): Outcome =>
  aws(['cloudformation', 'describe-stacks', '--stack-name', name]);

function simulate(principalArn: string, action: string, resource: string): Outcome {
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
    const outcome = classifyAwsError(stderr);
    if (outcome === 'unknown') {
      console.error(`      (判定不能) ${stderr.trim().split('\n')[0] ?? '(stderr 空)'}`);
    }
    return outcome;
  }
}

function main(): void {
  const simulateOnly = process.argv.includes('--simulate-only');
  const principalArn = process.env.SIMULATE_PRINCIPAL_ARN ?? `arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev`;
  const results: Array<{ id: string; expected: 'allowed' | 'denied'; actual: Outcome }> = [];

  if (!simulateOnly) {
    console.log('  実試行（副作用なし）:');
    for (const check of LIVE_CHECKS) {
      const actual = check.run();
      results.push({ id: check.id, expected: check.expected, actual });
      const pass = actual === check.expected;
      console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.description} → ${actual}（期待 ${check.expected}）`);
    }
  }

  console.log('  シミュレーション（破壊系は実試行しない）:');
  for (const check of SIMULATED_CHECKS) {
    const actual = simulate(principalArn, check.action, check.resource);
    results.push({ id: check.id, expected: 'denied', actual });
    const pass = actual === 'denied';
    console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.action} → ${actual}（期待 denied）`);
  }

  const { failed } = summarizeNegativeTests(results);
  if (failed > 0) {
    console.error(`  ⛔ negative security test: ${failed} 件が期待どおりでない`);
    process.exit(1);
  }
  console.log('  ✅ negative security test 全件 PASS');
}

main();
