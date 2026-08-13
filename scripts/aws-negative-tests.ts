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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyAwsError,
  classifySimulationError,
  coveredRegions,
  findUnsuppliedPrincipalKeys,
  principalArnKey,
  resolveExecutionScope,
  resolvePrincipalArnByKey,
  summarizeNegativeTests,
  uncoveredRegionNote,
  type NegativeTestResult,
  type Outcome,
  type PrincipalArnMap,
  type RegionCoverage,
  type SimulationPrincipal,
  type SimulationRegion,
} from '../src/domain/governance/negative-test-outcome';

const ACCOUNT = '822063948773';

/**
 * 🔴 **Permissions Boundary を simulate へ明示的に渡す (#680 R10 / D)。**
 *
 * carve-out は **2 枚**（`claude-cfn-exec.json` の Allow と `claude-boundary.json` の
 * `NotResource`）で成立している。boundary 側が抜けていれば `iam:CreateRole` は
 * **初回デプロイで Deny される** —— つまり carve-out の「壊れると一番痛い半分」は
 * boundary の方である。
 *
 * `SimulatePrincipalPolicy` に principal のアタッチ済み boundary が自動で含まれるか
 * どうかは、**AWS を呼ばずには確かめられない**。含まれていなければ S17〜S20 は
 * `claude-cfn-exec.json` だけを見ていることになり、runbook には「検証済み」と
 * 記録される。**曖昧なまま「検証済み」と書かない**ため、明示的に渡す
 * （含まれている場合でも同じ文書を 2 度評価するだけで結果は変わらない）。
 *
 * 渡すのは `exec` だけ。`cdk bootstrap --custom-permissions-boundary` が boundary を
 * 付けるのは **cfn-exec role 1 つだけ**であり（runbook ステップ 2）、entry / deploy に
 * 付けると「実際には通る呼び出し」が denied に見える。
 */
const BOUNDARY_POLICY_PATH = join(__dirname, 'aws-policies', 'claude-boundary.json');

/** boundary が付く principal。ここを増やすときは runbook ステップ 2 の実配布と揃える。 */
const BOUNDARY_BEARING_PRINCIPALS: ReadonlySet<SimulationPrincipal> = new Set(['exec']);

/**
 * boundary ファイルが実在し、空でないことを確かめる。
 * **読めないまま「boundary 込みで検証した」と記録させない**（fail-closed）。
 */
function assertBoundaryPolicyReadable(): void {
  if (!existsSync(BOUNDARY_POLICY_PATH) || statSync(BOUNDARY_POLICY_PATH).size === 0) {
    console.error(`  ⛔ boundary ポリシーが読めません: ${BOUNDARY_POLICY_PATH}`);
    console.error('    boundary を含めずに simulate すると carve-out の半分しか検証できません（#680 R10）。');
    process.exit(2);
  }
}

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
 *
 * 🔴 **R4（2026-08-12 残件レビュー / #680）: region も宣言する。**
 *
 * 旧実装はリソース ARN を全部 `ap-northeast-1` にハードコードし、principal ARN も
 * 1 region 分しか受け取らなかった。runbook ステップ 4a は「us-east-1 側も
 * `-us-east-1` 版で 1 度実行する」と書いていたが、それで変わるのは
 * `--policy-source-arn` だけで、**評価されるリソースは ap-northeast-1 のまま**。
 * 運用者は「us-east-1 検証済み」と記録するのに、us-east-1 のリソースは一度も
 * シミュレートされていなかった。`resource` を region の関数にし、
 * `coverage` で「両方か、片方だけか（＋その理由）」を宣言させる。
 */
type SimulatedCheck = {
  readonly id: string;
  readonly action: string;
  /** リソース ARN。region を持たないリソース（IAM 等）は引数を無視する。 */
  readonly resource: (region: SimulationRegion) => string;
  readonly principals: ReadonlyArray<SimulationPrincipal>;
  readonly coverage: RegionCoverage;
  /** 期待する評価結果。carve-out（#680 R2）だけが `allowed` を期待する。 */
  readonly expected: 'allowed' | 'denied';
  /** どの層／どのステートメントを問うているか（結果の読み手向け）。 */
  readonly guards: string;
  /**
   * リクエスト側の context key（`--context-entries` の値そのまま）。
   *
   * `iam:PassedToService` のように**リクエストにしか現れない**キーを条件に持つ
   * ステートメントは、これを渡さないと「実際には通る呼び出し」が `denied` に見える。
   * 渡さないまま `expected: 'denied'` を書くと、**条件が効いているのか
   * context が無いだけなのか区別できない偽の PASS** になる。
   */
  readonly contextEntries?: ReadonlyArray<string>;
};

const BOTH: RegionCoverage = { kind: 'both' };

/**
 * carve-out（#680 R1/R2/R3）に一致する provider role の**実在／予測物理名**。
 * region ごとに違う ―― ap-northeast-1 では Web-dev の ExportWriter、
 * us-east-1 では CfMonitoring-dev の ExportReader が作られる。
 * 名前の導出は `src/domain/governance/cfn-generated-name.ts`、
 * 実測との突き合わせは `infra/test/claude-deploy-boundary.test.ts`。
 */
const CARVED_OUT_PROVIDER_ROLE: Readonly<Record<SimulationRegion, string>> = {
  'ap-northeast-1': 'OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw',
  'us-east-1': 'OpenReception-CfMonitoring-dev-CustomCrossRegionExp-aBcDeFgHiJkL',
};

const SIMULATED_CHECKS: ReadonlyArray<SimulatedCheck> = [
  {
    id: 'S1',
    action: 'dynamodb:DeleteTable',
    resource: (r) => `arn:aws:dynamodb:${r}:${ACCOUNT}:table/nodi-dev-anything`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3 DenyForeignProjectData',
  },
  {
    id: 'S2',
    action: 'cloudformation:DeleteStack',
    resource: (r) => `arn:aws:cloudformation:${r}:${ACCOUNT}:stack/nodi-dev-app/*`,
    principals: ['deploy', 'exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 1 DenyCloudFormationOutsideDevStacks / 層 3 DenyForeignProjectStacks',
  },
  {
    id: 'S3',
    action: 'secretsmanager:GetSecretValue',
    resource: (r) => `arn:aws:secretsmanager:${r}:${ACCOUNT}:secret:salon-loop/*`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3 DenySecretsDnsAndPrincipals（T8 の全面 Deny）',
  },
  {
    id: 'S4',
    action: 'iam:CreateRole',
    // IAM はグローバル。region が効くのは principal 側（bootstrap は region ごとに
    // 別の cfn-exec role を作る）。
    resource: () => `arn:aws:iam::${ACCOUNT}:role/any-new-role`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 4 DenyRoleCreationWithoutBoundary（boundary 指定なしの呼び出し）',
  },
  {
    id: 'S5',
    action: 'iam:AttachRolePolicy',
    resource: () => `arn:aws:iam::${ACCOUNT}:role/any-role`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 4 DenyRoleCreationWithoutBoundary',
  },
  {
    id: 'S6',
    action: 'iam:PassRole',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-${r}`,
    principals: ['deploy', 'exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 1 DenyPassingSharedExecRoles / 層 3 DenySharedBootstrapRoles',
  },
  {
    id: 'S7',
    action: 'iam:DeleteRolePermissionsBoundary',
    resource: () => `arn:aws:iam::${ACCOUNT}:role/any-role`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 4 DenyBoundaryEscape',
  },
  {
    id: 'S8',
    action: 'route53:ChangeResourceRecordSets',
    resource: () => 'arn:aws:route53:::hostedzone/ANY',
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3 DenySecretsDnsAndPrincipals（T9）',
  },
  {
    id: 'S9',
    action: 'cloudformation:UpdateStack',
    resource: (r) => `arn:aws:cloudformation:${r}:${ACCOUNT}:stack/OpenReception-Web-prod/*`,
    principals: ['deploy', 'exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 1・3 の OpenReception-*-prod Deny（T2）',
  },
  {
    id: 'S10',
    action: 'kms:ScheduleKeyDeletion',
    resource: (r) => `arn:aws:kms:${r}:${ACCOUNT}:key/any`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 4 DenySecretsAndKeyDestruction',
  },
  // 旧 N8（Important B で live check から移動）。長期 access key を実際に発行しかねない
  // ため、実試行せず SimulatePrincipalPolicy で判定する。
  {
    id: 'S11',
    action: 'iam:CreateAccessKey',
    resource: () => `arn:aws:iam::${ACCOUNT}:user/CDK`,
    principals: ['entry', 'exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: 'entry の DenyEverythingElseOutsideTheChain / 層 4 DenyPrincipalCreationAndOrgChanges',
  },
  // Critical 1（同レビュー）: lookup role は ReadOnlyAccess 付き・boundary 無し。
  // live check N9 と対になる simulate 版。bootstrap は両 region に lookup role を作るので
  // 両方問う（runbook ステップ 2 が `aws://…/ap-northeast-1 aws://…/us-east-1` を渡している）。
  {
    id: 'S12',
    action: 'sts:AssumeRole',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-lookup-role-${ACCOUNT}-${r}`,
    principals: ['entry'],
    coverage: BOTH,
    expected: 'denied',
    guards: 'entry の DenyBootstrapLookupRole（Critical 1）',
  },
  // Important 5（同レビュー）: 自分のチェーンから層 1 のインラインポリシーを剥がせないこと。
  {
    id: 'S13',
    action: 'iam:DeleteRolePolicy',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/cdk-orcloud01-deploy-role-${ACCOUNT}-${r}`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3 DenyIamWriteOnForeignPrincipals（自分のチェーンを含む。Important 5）',
  },
  {
    id: 'S14',
    action: 'iam:CreatePolicyVersion',
    resource: () => `arn:aws:iam::${ACCOUNT}:policy/SalonLoopStagingCfnExecution`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3 DenyIamWriteOnForeignPrincipals（他プロジェクトのポリシー。Important 5）',
  },
  // ---- #680 R4: us-east-1 にしか存在しないリソースを実際に問う ----
  {
    id: 'S15',
    action: 'cloudformation:DescribeStacks',
    resource: () =>
      `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/OpenReception-CfMonitoring-dev/dummy-id`,
    principals: ['entry'],
    coverage: {
      kind: 'only',
      region: 'us-east-1',
      reason: 'OpenReception-CfMonitoring-dev は us-east-1 にしか存在しない（CloudFront メトリクスの制約）',
    },
    expected: 'allowed',
    guards: 'entry の ReadOwnDevStacksForDiffGate（us-east-1 の stack ARN が許可リストにあるか）',
  },
  {
    id: 'S16',
    action: 'cloudformation:DescribeChangeSet',
    resource: () =>
      `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/claude-gate-abc1234/dummy-id`,
    principals: ['entry'],
    coverage: {
      kind: 'only',
      region: 'us-east-1',
      reason: 'ap-northeast-1 側は S15 と対になる既存の手動確認（runbook 4b-2）で覆っている',
    },
    expected: 'allowed',
    guards: 'entry の ReadOwnChangeSetsForDiffGate（us-east-1 の changeSet ARN）',
  },
  // ---- #680 R2: carve-out そのものを問う対（片方だけでは意味を成さない） ----
  {
    // 🔴 boundary を渡さずに CreateRole する ―― `iam:PermissionsBoundary` context key を
    // 供給しないので、IAM 側では「boundary なしの CreateRole」として評価される。
    // carve-out が効いていれば **allowed**。効いていなければ初回デプロイが
    // AccessDenied → rollback → ROLLBACK_FAILED になる。
    id: 'S17',
    action: 'iam:CreateRole',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/${CARVED_OUT_PROVIDER_ROLE[r]}`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'allowed',
    guards: '層 3・4 AllowCdkProviderRoleMutationWithoutBoundary（#680 R1）',
  },
  {
    // S17 の対。carve-out が広すぎないこと。S4 と違い「carve-out に**似ているが
    // 一致しない**名前」を使う ―― `-dev-Custom` で始まらないアプリの通常ロール。
    id: 'S18',
    action: 'iam:CreateRole',
    resource: () => `arn:aws:iam::${ACCOUNT}:role/OpenReception-Web-dev-ServerFnServiceRole-xxxx`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3・4 DenyRoleCreationWithoutBoundary（carve-out の外は従来どおり）',
  },
  {
    // rollback / teardown が provider role を消せること（タグが無いので
    // `DenyIamRoleWriteOutsideProject` に当たっていた）。
    id: 'S19',
    action: 'iam:DeleteRole',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/${CARVED_OUT_PROVIDER_ROLE[r]}`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'allowed',
    guards: '層 3・4 DenyIamRoleWriteOutsideProject の NotResource 除外（#680 R3）',
  },
  {
    // S19 の対。タグの無い**別の**ロールは従来どおり消せない。
    id: 'S20',
    action: 'iam:DeleteRole',
    resource: () => `arn:aws:iam::${ACCOUNT}:role/some-untagged-role`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    guards: '層 3・4 DenyIamRoleWriteOutsideProject（carve-out の外は従来どおり）',
  },
  // ---- #680 R10: PassRole の対（`iam:PassedToService` を実際に供給して問う） ----
  {
    // 🔴 これまで S 系に無かった。`iam:PassedToService` を渡せないから、という理由で
    // 落としていたが、`--context-entries` で渡せる。渡さずに諦めると
    // 「carve-out の PassRole が本当に通るのか」を初回デプロイまで誰も知らない。
    id: 'S21',
    action: 'iam:PassRole',
    resource: (r) => `arn:aws:iam::${ACCOUNT}:role/${CARVED_OUT_PROVIDER_ROLE[r]}`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'allowed',
    contextEntries: [
      'ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string',
    ],
    guards: '層 3・4 AllowPassRoleToCdkProviderRoles（タグ条件を外し PassedToService は維持）',
  },
  {
    // S21 の対。carve-out の外はタグ条件が残るので、タグの無いロールは渡せない。
    // **同じ context を渡している**ので、denied の理由が「context 不足」でないと言える。
    id: 'S22',
    action: 'iam:PassRole',
    resource: () => `arn:aws:iam::${ACCOUNT}:role/some-untagged-role`,
    principals: ['exec'],
    coverage: BOTH,
    expected: 'denied',
    contextEntries: [
      'ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string',
    ],
    guards: '層 3 AllowPassRoleOnlyToTaggedDevWorkloads（タグ条件が残る＝Allow が成立しない）',
  },
];

/**
 * principal 鍵 → 環境変数名。**既定値は持たない**（Critical 3）。
 *
 * `entry` は IAM ロール 1 本なので region を持たない。`deploy` / `exec` は
 * bootstrap が region ごとに別のロールを作るので、**region ごとに別の変数**である
 * （#680 R4。片方だけ渡して「両方検証した」と記録できないようにする）。
 */
const PRINCIPAL_ENV_VARS: Readonly<Record<string, string>> = {
  entry: 'SIMULATE_ENTRY_ROLE_ARN',
  'deploy@ap-northeast-1': 'SIMULATE_DEPLOY_ROLE_ARN_AP_NORTHEAST_1',
  'deploy@us-east-1': 'SIMULATE_DEPLOY_ROLE_ARN_US_EAST_1',
  'exec@ap-northeast-1': 'SIMULATE_EXEC_ROLE_ARN_AP_NORTHEAST_1',
  'exec@us-east-1': 'SIMULATE_EXEC_ROLE_ARN_US_EAST_1',
};

/**
 * 廃止された環境変数。設定されていたら実行を拒否する。
 *
 * `SIMULATE_PRINCIPAL_ARN` は Critical 3（1 本で全 S 系を評価する形）、
 * `SIMULATE_{DEPLOY,EXEC}_ROLE_ARN` は R4（region 無しの 1 本）。どちらも
 * **古い手順のまま実行して「検証済み」と記録できてしまう**形なので、無言で
 * 無視せず止める。
 */
const RETIRED_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  [
    'SIMULATE_PRINCIPAL_ARN',
    '1 本の ARN で全 S 系を評価すると、entry role に対して boundary 脱出を聞くことになり検査が常に PASS します',
  ],
  [
    'SIMULATE_DEPLOY_ROLE_ARN',
    'deploy role は region ごとに別物です。_AP_NORTHEAST_1 / _US_EAST_1 を使ってください',
  ],
  [
    'SIMULATE_EXEC_ROLE_ARN',
    'cfn-exec role は region ごとに別物です。_AP_NORTHEAST_1 / _US_EAST_1 を使ってください',
  ],
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
function simulate(
  principalArn: string,
  action: string,
  resource: string,
  options: {
    /** principal に Permissions Boundary が付いているか（`exec` だけ true）。 */
    readonly withBoundary: boolean;
    /** `iam:PassedToService` のようなリクエスト側 context key。 */
    readonly contextEntries?: ReadonlyArray<string>;
  },
): Outcome {
  refuseUnderTestRuntime(`iam simulate-principal-policy (${action})`);
  try {
    const out = execFileSync(
      'aws',
      [
        'iam', 'simulate-principal-policy',
        '--policy-source-arn', principalArn,
        '--action-names', action,
        '--resource-arns', resource,
        // 🔴 boundary は carve-out の「壊れると初回デプロイが落ちる方の半分」。
        // 自動で含まれるかを AWS 抜きで確かめられない以上、明示的に渡す。
        //
        // 🔴 **`file://` を渡してはいけない。** このオプションは *リスト* を取るので、
        // CLI は `file://` の中身を「リストそのもの」として解釈しようとする。ポリシー文書は
        // 配列ではなくオブジェクトなので `ValidationError: Value '[{,` で落ち、boundary を
        // 渡す全 check（= exec ロールの 38 件）が丸ごと `unknown` になる。
        // **`unknown` は期待が denied でも PASS にしないため FAIL として出はするが、
        // 「ポリシーが悪い」ようにしか見えず、原因がツール側だと分からない**（2026-08-13 に実測）。
        // 文書の中身を argv の 1 要素として渡すのが正しい（`execFileSync` なのでシェル解釈は無い）。
        ...(options.withBoundary
          ? [
              '--permissions-boundary-policy-input-list',
              readFileSync(BOUNDARY_POLICY_PATH, 'utf8'),
            ]
          : []),
        ...(options.contextEntries && options.contextEntries.length > 0
          ? ['--context-entries', ...options.contextEntries]
          : []),
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

  // 🔴 **旧変数を黙って無視しない。** 設定されたまま新実装を走らせると、runbook や
  // 手癖が古いままであることに誰も気づけない。明示的に止める。
  for (const [name, why] of RETIRED_ENV_VARS) {
    if (process.env[name] !== undefined) {
      console.error(
        `  ⛔ ${name} は廃止されました（${why}）。` +
          `代わりに ${Object.values(PRINCIPAL_ENV_VARS).join(' / ')} を設定してください。`,
      );
      process.exit(2);
    }
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
    const arns: PrincipalArnMap = Object.fromEntries(
      Object.entries(PRINCIPAL_ENV_VARS).map(([key, envVar]) => [key, process.env[envVar]]),
    );
    /** 実際に評価する (check, principal, region) の全組み合わせ。 */
    const plan = SIMULATED_CHECKS.flatMap((check) =>
      coveredRegions(check.coverage).flatMap((region) =>
        check.principals.map((principal) => ({
          check,
          principal,
          region,
          key: principalArnKey(principal, region),
        })),
      ),
    );
    const missing = findUnsuppliedPrincipalKeys(
      plan.map((p) => p.key),
      arns,
    );
    // 🔴 **供給されていない principal があれば実行しない。** 既定値で埋めると
    // 「どのロールを検査したのか」が呼び出し側から見えなくなり、Critical 3 が再演する。
    if (missing.length > 0) {
      console.error('  ⛔ S 系の評価に必要な principal ARN が供給されていません:');
      for (const key of missing) {
        console.error(`    - ${key}: 環境変数 ${PRINCIPAL_ENV_VARS[key]} を設定してください`);
      }
      console.error('    （docs/runbook-cloud-aws-deploy.md ステップ 4a を参照）');
      process.exit(2);
    }

    assertBoundaryPolicyReadable();
    console.log('  シミュレーション（破壊系は実試行しない）:');
    // 🔴 **覆っていない region を先に印字する。** 「全件 PASS」を「両 region 検証済み」と
    // 読み違えさせないため、スキップした範囲とその理由を結果より前に出す（#680 R4）。
    for (const check of SIMULATED_CHECKS) {
      const note = uncoveredRegionNote(check.coverage);
      if (note !== null) console.log(`    ℹ️  ${check.id}: ${note}`);
    }
    for (const { check, principal, region, key } of plan) {
      const arn = resolvePrincipalArnByKey(key, arns);
      // `missing` チェックを通っているのでここには来ないが、型を絞るために残す。
      if (arn === null) continue;
      const resource = check.resource(region);
      const withBoundary = BOUNDARY_BEARING_PRINCIPALS.has(principal);
      const actual = simulate(arn, check.action, resource, {
        withBoundary,
        ...(check.contextEntries === undefined ? {} : { contextEntries: check.contextEntries }),
      });
      results.push({
        id: `${check.id}[${key}]`,
        expected: check.expected,
        actual,
        requiredPrincipalArn: arn,
        evaluatedPrincipalArn: arn,
      });
      const pass = actual === check.expected;
      // 🔴 **principal・region・リソースを結果と同じ行に出す。** どのロールを・どの
      // region の何に対して検査したのかを読み手が取り違えられないようにする
      // （Critical 3 / R4 の再演防止は型だけでは足りない）。
      console.log(
        `    ${pass ? '✅' : '❌'} ${check.id} [${principal}@${region}] ${check.action} → ${actual}（期待 ${check.expected}）\n` +
          `        principal=${arn}\n` +
          `        resource=${resource}\n` +
          // 🔴 **何を込みで評価したのかを結果と同じ行に出す。** boundary 抜きの評価を
          // 「boundary 込みで検証済み」と記録させないため（#680 R10 / D）。
          `        boundary=${withBoundary ? BOUNDARY_POLICY_PATH : '(なし: この principal に boundary は付かない)'}\n` +
          `        context=${check.contextEntries?.join(' ') ?? '(なし)'}\n` +
          `        guards=${check.guards}`,
      );
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
