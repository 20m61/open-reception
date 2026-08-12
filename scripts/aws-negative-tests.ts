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
  resolveExecutionScope,
  summarizeNegativeTests,
  type Outcome,
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

/** 実試行しない。`SimulatePrincipalPolicy` で判定する（人間の Admin 環境から実行）。 */
const SIMULATED_CHECKS: ReadonlyArray<{
  readonly id: string;
  readonly action: string;
  readonly resource: string;
}> = [
  { id: 'S1', action: 'dynamodb:DeleteTable', resource: `arn:aws:dynamodb:ap-northeast-1:${ACCOUNT}:table/nodi-dev-anything` },
  { id: 'S2', action: 'cloudformation:DeleteStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/nodi-dev-app/*` },
  { id: 'S3', action: 'secretsmanager:GetSecretValue', resource: `arn:aws:secretsmanager:ap-northeast-1:${ACCOUNT}:secret:salon-loop/*` },
  { id: 'S4', action: 'iam:CreateRole', resource: `arn:aws:iam::${ACCOUNT}:role/any-new-role` },
  { id: 'S5', action: 'iam:AttachRolePolicy', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S6', action: 'iam:PassRole', resource: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-ap-northeast-1` },
  { id: 'S7', action: 'iam:DeleteRolePermissionsBoundary', resource: `arn:aws:iam::${ACCOUNT}:role/any-role` },
  { id: 'S8', action: 'route53:ChangeResourceRecordSets', resource: 'arn:aws:route53:::hostedzone/ANY' },
  { id: 'S9', action: 'cloudformation:UpdateStack', resource: `arn:aws:cloudformation:ap-northeast-1:${ACCOUNT}:stack/OpenReception-Web-prod/*` },
  { id: 'S10', action: 'kms:ScheduleKeyDeletion', resource: `arn:aws:kms:ap-northeast-1:${ACCOUNT}:key/any` },
  // 旧 N8（Important B で live check から移動）。長期 access key を実際に発行しかねない
  // ため、実試行せず SimulatePrincipalPolicy で判定する。
  { id: 'S11', action: 'iam:CreateAccessKey', resource: `arn:aws:iam::${ACCOUNT}:user/CDK` },
];

/**
 * 🔴 **stderr を診断に載せる。** `execFileSync` の例外は `message` がコマンド行までで、
 * 理由は `stderr` にある。載せないと 3 周にわたって当て推量で直すことになる（2026-08-08 の実例）。
 *
 * ここで実行するのは**評価対象の操作そのもの**（N1〜N7。旧 N8 は Important B で
 * `SIMULATED_CHECKS` の `S11` へ移動済み）。だから `classifyAwsError` を
 * 使ってよい ―― この呼び出しへの AccessDenied は、まさにその操作が denied だったことを
 * 意味する。`simulate()`（別の API を呼ぶ）と混同しないこと。
 */
function aws(args: ReadonlyArray<string>): Outcome {
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

  const principalArn = process.env.SIMULATE_PRINCIPAL_ARN ?? `arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev`;
  const results: Array<{ id: string; expected: 'allowed' | 'denied'; actual: Outcome }> = [];

  if (scope !== 'simulate') {
    console.log('  実試行（副作用なし）:');
    for (const check of LIVE_CHECKS) {
      const actual = check.run();
      results.push({ id: check.id, expected: check.expected, actual });
      const pass = actual === check.expected;
      console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.description} → ${actual}（期待 ${check.expected}）`);
    }
  }

  if (scope !== 'live') {
    console.log('  シミュレーション（破壊系は実試行しない）:');
    for (const check of SIMULATED_CHECKS) {
      const actual = simulate(principalArn, check.action, check.resource);
      results.push({ id: check.id, expected: 'denied', actual });
      const pass = actual === 'denied';
      console.log(`    ${pass ? '✅' : '❌'} ${check.id} ${check.action} → ${actual}（期待 denied）`);
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

  const { failed } = summarizeNegativeTests(results);
  if (failed > 0) {
    console.error(`  ⛔ negative security test: ${failed} 件が期待どおりでない（実行範囲: ${scopeLabel}）`);
    process.exit(1);
  }
  console.log(`  ✅ negative security test PASS（実行範囲: ${scopeLabel}）`);
}

main();
