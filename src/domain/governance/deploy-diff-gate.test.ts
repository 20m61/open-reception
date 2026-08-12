/**
 * change set の危険判定 (spec §6)。
 *
 * `cdk diff` のテキストではなく `aws cloudformation describe-change-set` の JSON を
 * 入力にする。テキスト parse は取りこぼすため。
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STACK_PATTERN,
  REVIEWED_CDK_GENERATED_LOGICAL_IDS,
  evaluateDeployChangeSet,
  type ChangeSetResourceChange,
  type ChangeSetSummary,
  type TemplateProperties,
} from './deploy-diff-gate';

const change = (over: Partial<ChangeSetResourceChange> = {}): ChangeSetResourceChange => ({
  action: 'Modify',
  resourceType: 'AWS::Lambda::Function',
  logicalResourceId: 'ServerFn',
  replacement: 'False',
  ...over,
});

const summary = (over: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  stackName: 'OpenReception-Web-dev',
  changes: [change()],
  templateResources: {},
  ...over,
});

describe('通すべきものを通す', () => {
  it('Lambda の非置換 Modify は通る', () => {
    const verdict = evaluateDeployChangeSet(summary());
    expect(verdict.blocked).toBe(false);
    expect(verdict.blocks).toEqual([]);
  });

  it('変更ゼロ（no-op deploy）は通る', () => {
    expect(evaluateDeployChangeSet(summary({ changes: [] })).blocked).toBe(false);
  });

  it('Add は通る', () => {
    expect(evaluateDeployChangeSet(summary({ changes: [change({ action: 'Add' })] })).blocked).toBe(
      false,
    );
  });

  it('Modify で replacement=False は通る（安全な Update を許可する）', () => {
    expect(
      evaluateDeployChangeSet(summary({ changes: [change({ action: 'Modify', replacement: 'False' })] }))
        .blocked,
    ).toBe(false);
  });
});

describe('停止する', () => {
  it.each<[string, Partial<ChangeSetSummary>, string]>([
    [
      'スタック名が dev でない',
      { stackName: 'OpenReception-Web-prod' },
      'unexpectedStack',
    ],
    [
      'スタック名が他プロジェクト',
      { stackName: 'nodi-dev-app' },
      'unexpectedStack',
    ],
    [
      'リソース削除',
      { changes: [change({ action: 'Remove' })] },
      'resourceRemoval',
    ],
    [
      'Replacement True',
      { changes: [change({ replacement: 'True' })] },
      'resourceReplacement',
    ],
    [
      'Replacement Conditional も止める',
      { changes: [change({ replacement: 'Conditional' })] },
      'resourceReplacement',
    ],
    [
      'KMS は Add でも止める',
      { changes: [change({ action: 'Add', resourceType: 'AWS::KMS::Key' })] },
      'kmsChange',
    ],
    [
      'SecretsManager は Add でも止める',
      { changes: [change({ action: 'Add', resourceType: 'AWS::SecretsManager::Secret' })] },
      'secretsChange',
    ],
    [
      'Route53',
      { changes: [change({ resourceType: 'AWS::Route53::RecordSet' })] },
      'dnsOrCertificateChange',
    ],
    [
      'ACM',
      { changes: [change({ resourceType: 'AWS::CertificateManager::Certificate' })] },
      'dnsOrCertificateChange',
    ],
    [
      'SecurityGroup',
      { changes: [change({ resourceType: 'AWS::EC2::SecurityGroupIngress' })] },
      'networkBoundaryChange',
    ],
    [
      'IAM User の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::User' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM AccessKey の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::AccessKey' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM Group の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::Group' })] },
      'iamPrincipalChange',
    ],
    [
      'IAM UserToGroupAddition の作成',
      { changes: [change({ action: 'Add', resourceType: 'AWS::IAM::UserToGroupAddition' })] },
      'iamPrincipalChange',
    ],
    [
      'Dynamic action は未知なので止める',
      { changes: [change({ action: 'Dynamic' })] },
      'unknownAction',
    ],
    [
      'Import action は未知なので止める',
      { changes: [change({ action: 'Import' })] },
      'unknownAction',
    ],
  ])('%s', (_name, over, reason) => {
    const verdict = evaluateDeployChangeSet(summary(over));
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocks.map((b) => b.reason)).toContain(reason);
  });

  it('根拠に論理 ID とリソース種別が載る（人が確認できないと信用できない）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [change({ action: 'Remove', logicalResourceId: 'DataTable' })] }),
    );
    const evidence = verdict.blocks.map((b) => b.evidence).join('\n');
    expect(evidence).toContain('DataTable');
    expect(evidence).toContain('AWS::Lambda::Function');
  });
});

describe('記録のみ（止めない）', () => {
  it('boundary の掛かる通常の IAM Role の Modify は flag だけで通す', () => {
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [change({ resourceType: 'AWS::IAM::Role', logicalResourceId: 'ServerFnServiceRole' })],
        templateResources: { ServerFnServiceRole: lambdaServiceRole() },
      }),
    );
    expect(verdict.blocked).toBe(false);
    expect(verdict.flags.map((f) => f.reason)).toContain('iamPolicyChange');
  });

  it('IAM Role の Remove は止める（flag では済ませない）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [change({ action: 'Remove', resourceType: 'AWS::IAM::Role' })] }),
    );
    expect(verdict.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #680 R10: carve-out を diff gate で制動する
// ---------------------------------------------------------------------------

/** 実測した CDK `CustomResourceProvider` role の trust policy（synth 出力そのまま）。 */
const PROVIDER_TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } },
  ],
};

/** 実測した provider role の `ManagedPolicyArns`（`Fn::Sub` の文字列形）。 */
const PROVIDER_MANAGED = [
  { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
];

/** 実測した cross-region ExportWriter のインラインポリシー。 */
const PROVIDER_INLINE = [
  {
    PolicyName: 'Inline',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Resource: ['arn:aws:ssm:us-east-1:822063948773:parameter/cdk/exports/*'],
          Action: ['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'],
        },
      ],
    },
  },
];

const providerRole = (over: TemplateProperties = {}): TemplateProperties => ({
  AssumeRolePolicyDocument: PROVIDER_TRUST,
  ManagedPolicyArns: PROVIDER_MANAGED,
  Policies: PROVIDER_INLINE,
  ...over,
});

/** boundary もタグも付く、アプリの普通の Lambda 実行ロール。 */
const lambdaServiceRole = (over: TemplateProperties = {}): TemplateProperties => ({
  AssumeRolePolicyDocument: PROVIDER_TRUST,
  PermissionsBoundary: 'arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary',
  ...over,
});

const roleChange = (logicalId: string, action = 'Add'): ChangeSetResourceChange =>
  change({ action, resourceType: 'AWS::IAM::Role', logicalResourceId: logicalId, replacement: undefined });

const evaluateRoleFixture = (
  logicalId: string,
  props: TemplateProperties,
  opts: { readonly action?: string; readonly stackName?: string } = {},
) =>
  evaluateDeployChangeSet(
    summary({
      ...(opts.stackName === undefined ? {} : { stackName: opts.stackName }),
      changes: [roleChange(logicalId, opts.action)],
      templateResources: { [logicalId]: props },
    }),
  );

const [S3_AUTO_DELETE_ROLE, EXPORT_WRITER_ROLE, EXPORT_READER_ROLE] =
  REVIEWED_CDK_GENERATED_LOGICAL_IDS.carveOutProviderRoles;

describe('A: carve-out の名前空間に入るロールを止める (#680 R10)', () => {
  it('🔴 空虚に真になっていないことの対照: 既知の 3 本は 3 本とも通る', () => {
    // 通らなければ**初回デプロイが gate で止まる**（carve-out を足した意味が消える）。
    const passed = [
      evaluateRoleFixture(S3_AUTO_DELETE_ROLE!, providerRole({ Policies: undefined })),
      evaluateRoleFixture(EXPORT_WRITER_ROLE!, providerRole()),
      evaluateRoleFixture(EXPORT_READER_ROLE!, providerRole(), {
        stackName: 'OpenReception-CfMonitoring-dev',
      }),
    ];
    expect(passed.map((v) => v.blocks.map((b) => b.reason))).toEqual([[], [], []]);
  });

  it('carve-out に入る未知の論理 ID は止める（construct の id を Custom… にするだけの経路）', () => {
    const verdict = evaluateRoleFixture('CustomEvilProviderRole', providerRole());
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleNamespace']);
  });

  it('🔴 RoleName を明示して名前空間へ入る経路も止める（論理 ID は無害なまま）', () => {
    const verdict = evaluateRoleFixture(
      'HarmlessLookingRole',
      providerRole({ RoleName: 'OpenReception-Web-dev-CustomAnything' }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleNamespace']);
  });

  it('🔴 Path を細工して名前空間へ入る経路も止める（IAM のグロブでは * が / を跨ぐ）', () => {
    // 人間が名前だけ眺めても気づけない形。`role/OpenReception-x-dev-Custom/<名前>` になる。
    const verdict = evaluateRoleFixture(
      'AlsoHarmlessLooking',
      providerRole({ Path: '/OpenReception-x-dev-Custom/' }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleNamespace']);
  });

  it('carve-out の外の普通のロールは通す（初回デプロイを壊さない）', () => {
    const verdict = evaluateRoleFixture('ServerFnServiceRole', lambdaServiceRole());
    expect(verdict.blocked).toBe(false);
  });

  it('物理名を決定できない（RoleName が組み込み関数）なら止める', () => {
    const verdict = evaluateRoleFixture(
      'DynamicallyNamed',
      providerRole({ RoleName: { 'Fn::Join': ['', ['a', 'b']] } }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });

  it('change set にあるのに synth テンプレートに無いロールは止める（読めなかったを問題なしにしない）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({ changes: [roleChange('GhostRole')], templateResources: {} }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });
});

describe('A: 論理 ID を騙っても中身で弾く（allowlist だけでは足りない） (#680 R10)', () => {
  it.each<[string, TemplateProperties]>([
    [
      'trust policy を外部アカウントへ向ける',
      providerRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' } },
          ],
        },
      }),
    ],
    [
      'trust policy を "AWS":"*" にする',
      providerRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: '*' } }],
        },
      }),
    ],
    [
      'trust policy を Federated にする',
      providerRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Principal: { Federated: 'arn:aws:iam::822063948773:oidc-provider/token.actions.githubusercontent.com' },
            },
          ],
        },
      }),
    ],
    [
      'AdministratorAccess を attach する',
      providerRole({ ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'] }),
    ],
    [
      'インラインで iam: を許可する',
      providerRole({
        Policies: [
          {
            PolicyName: 'Inline',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: ['iam:PutRolePolicy'], Resource: '*' }],
            },
          },
        ],
      }),
    ],
    [
      'インラインで Action:* を許可する',
      providerRole({
        Policies: [
          {
            PolicyName: 'Inline',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
            },
          },
        ],
      }),
    ],
  ])('既知の provider role の論理 ID を名乗って %s → 止める', (_name, props) => {
    const verdict = evaluateRoleFixture(EXPORT_WRITER_ROLE!, props);
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  // 🔴 Modify を見る理由そのもの。物理名は変わらないので A の名前判定だけでは素通りする。
  it('Modify で既存 provider role の trust policy を外部アカウントへ向けるのも止める', () => {
    const verdict = evaluateRoleFixture(
      EXPORT_WRITER_ROLE!,
      providerRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' } },
          ],
        },
      }),
      { action: 'Modify' },
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });
});

describe('carve-out の外のロールの trust policy (#680 R10)', () => {
  it('外部アカウントを信頼する通常のロールは止める（boundary は信頼先を縛れない）', () => {
    const verdict = evaluateRoleFixture(
      'ServerFnServiceRole',
      lambdaServiceRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' } },
          ],
        },
      }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['roleTrustPolicyEscape']);
  });

  it('trust policy が組み込み関数で読み切れないときは止めずに記録する（正当な初回デプロイを壊さない）', () => {
    const verdict = evaluateRoleFixture(
      'ServerFnServiceRole',
      lambdaServiceRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { AWS: { 'Fn::Join': ['', ['arn:aws:iam::822063948773:root']] } },
            },
          ],
        },
      }),
    );
    expect(verdict.blocked).toBe(false);
    expect(verdict.flags.map((f) => f.reason)).toContain('opaqueRoleTrustPolicy');
  });
});

describe('B: Function URL と公開 invoke (#680 R10)', () => {
  const [SERVER_URL, IMAGE_URL] = REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls;

  const urlVerdict = (logicalId: string, authType: unknown, action = 'Add') =>
    evaluateDeployChangeSet(
      summary({
        changes: [
          change({ action, resourceType: 'AWS::Lambda::Url', logicalResourceId: logicalId, replacement: undefined }),
        ],
        templateResources: { [logicalId]: { AuthType: authType } },
      }),
    );

  it('🔴 空虚に真になっていないことの対照: WebStack の 2 本は両方式とも通る', () => {
    // `Web-dev` の作り直し（全リソースが Add）が gate で止まってはならない。
    expect(urlVerdict(SERVER_URL!, 'AWS_IAM').blocks).toEqual([]); // OAC 方式
    expect(urlVerdict(SERVER_URL!, 'NONE').blocks).toEqual([]); // origin-verify 方式
    expect(urlVerdict(IMAGE_URL!, 'AWS_IAM').blocks).toEqual([]);
  });

  it('未知の Function URL の Add は止める（無条件許可でも無条件停止でもない）', () => {
    const verdict = urlVerdict('EvilFnFunctionUrlDEADBEEF', 'NONE');
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('image の Function URL を NONE へ倒す Modify は止める (#631)', () => {
    const verdict = urlVerdict(IMAGE_URL!, 'NONE', 'Modify');
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('AuthType がリテラルでなければ止める', () => {
    const verdict = urlVerdict(SERVER_URL!, { Ref: 'AuthParam' });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });

  const permVerdict = (logicalId: string, principal: unknown) =>
    evaluateDeployChangeSet(
      summary({
        changes: [
          change({
            action: 'Add',
            resourceType: 'AWS::Lambda::Permission',
            logicalResourceId: logicalId,
            replacement: undefined,
          }),
        ],
        templateResources: { [logicalId]: { Principal: principal, Action: 'lambda:InvokeFunctionUrl' } },
      }),
    );

  it('CloudFront への OAC 許可は通る（論理 ID を数え上げずに済む形にしてある）', () => {
    expect(permVerdict('DistributionOacPermission', 'cloudfront.amazonaws.com').blocks).toEqual([]);
  });

  it('origin-verify 方式で CDK が足す Principal:"*" の 2 本は通る', () => {
    for (const id of REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions) {
      expect(permVerdict(id, '*').blocks).toEqual([]);
    }
  });

  it('未知の Principal:"*" invoke 許可は止める（資格情報が切れても残る）', () => {
    expect(permVerdict('EvilPublicInvoke', '*').blocks.map((b) => b.reason)).toEqual([
      'publicInvokePermission',
    ]);
  });

  it('別アカウントへの invoke 許可も止める', () => {
    expect(
      permVerdict('CrossAccountInvoke', 'arn:aws:iam::111122223333:root').blocks.map((b) => b.reason),
    ).toEqual(['publicInvokePermission']);
  });
});

describe('ALLOWED_STACK_PATTERN', () => {
  it.each(['OpenReception-Web-dev', 'OpenReception-WebMonitoring-dev', 'OpenReception-CfMonitoring-dev'])(
    '%s は許可',
    (name) => expect(ALLOWED_STACK_PATTERN.test(name)).toBe(true),
  );
  it.each([
    'OpenReception-Web-staging',
    'OpenReception-Web-prod',
    'OpenReception-Web-dev-extra',
    'XOpenReception-Web-dev',
    'nodi-dev-app',
    'salon-loop-staging-data',
  ])('%s は不許可', (name) => expect(ALLOWED_STACK_PATTERN.test(name)).toBe(false));
});
