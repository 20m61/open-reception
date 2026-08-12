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
  type TemplateResource,
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

/** synth テンプレートの 1 リソース（`Type` + `Properties`）。 */
const res = (type: string, properties: TemplateProperties): TemplateResource => ({
  type,
  properties,
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
        templateResources: { ServerFnServiceRole: res('AWS::IAM::Role', lambdaServiceRole()) },
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

/**
 * 実測した cross-region ExportWriter のインラインポリシー。
 *
 * 🔴 **`Resource` は synth 出力そのまま（`Fn::Join` ＋ `Ref: AWS::Partition`）にしてある。**
 * ここを手書きのリテラル ARN に「読みやすく」直すと、**実テンプレートを止めてしまう
 * 実装でもテストが緑になる**（gate は組み込み関数を解決できなければ通さない）。
 */
const SSM_EXPORTS_ARN = (suffix: string): unknown => ({
  'Fn::Join': [
    '',
    ['arn:', { Ref: 'AWS::Partition' }, `:ssm:us-east-1:822063948773:parameter/cdk/exports/${suffix}`],
  ],
});

const PROVIDER_INLINE = [
  {
    PolicyName: 'Inline',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Resource: [SSM_EXPORTS_ARN('*')],
          Action: ['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'],
        },
      ],
    },
  },
];

/**
 * 実測した cross-region ExportReader のインラインポリシー（**Writer と action が違う**）。
 * allowlist は 2 本ぶんの実測の和集合でなければ初回デプロイを止めてしまう。
 */
const PROVIDER_INLINE_READER = [
  {
    PolicyName: 'Inline',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          // Reader は配列でなく単一の値（実測）。両方の形を通す必要がある。
          Resource: SSM_EXPORTS_ARN('OpenReception-CfMonitoring-dev/*'),
          Action: ['ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource', 'ssm:GetParameters'],
        },
      ],
    },
  },
];

/**
 * 任意の action 1 つを持つインラインポリシー。
 * **`Resource` は許可リスト内**にしてある —— そうしないと「action の検査が効いた」のか
 * 「Resource の検査が効いた」のか区別できず、action 側の変異を検出できない。
 */
const inlineWith = (action: string, resource: unknown = SSM_EXPORTS_ARN('*')): ReadonlyArray<unknown> => [
  {
    PolicyName: 'Inline',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: action, Resource: resource }],
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
      templateResources: { [logicalId]: res('AWS::IAM::Role', props) },
    }),
  );

const [S3_AUTO_DELETE_ROLE, EXPORT_WRITER_ROLE, EXPORT_READER_ROLE] =
  REVIEWED_CDK_GENERATED_LOGICAL_IDS.carveOutProviderRoles;

const ACCOUNT = '822063948773';

const URL_TARGETS: Readonly<Record<string, string>> =
  REVIEWED_CDK_GENERATED_LOGICAL_IDS.functionUrls;
const PERMISSION_TARGETS: Readonly<Record<string, string>> =
  REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions;

const [SERVER_URL, IMAGE_URL] = Object.keys(URL_TARGETS) as [string, string];
const SERVER_FN = URL_TARGETS[SERVER_URL]!;

describe('A: carve-out の名前空間に入るロールを止める (#680 R10)', () => {
  it('🔴 空虚に真になっていないことの対照: 既知の 3 本は 3 本とも通る', () => {
    // 通らなければ**初回デプロイが gate で止まる**（carve-out を足した意味が消える）。
    const passed = [
      evaluateRoleFixture(S3_AUTO_DELETE_ROLE!, providerRole({ Policies: undefined })),
      evaluateRoleFixture(EXPORT_WRITER_ROLE!, providerRole()),
      evaluateRoleFixture(EXPORT_READER_ROLE!, providerRole({ Policies: PROVIDER_INLINE_READER }), {
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

  it('🔴 change set の種別とテンプレートの種別が食い違えば止める', () => {
    // 変異ドリル M38 が生き残って見つけた穴。change set 側の綴りだけで検査対象を
    // 決めていると、テンプレート側が Role でも「Lambda の変更」として素通りしうる。
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [
          change({ action: 'Add', resourceType: 'AWS::Lambda::Function', logicalResourceId: 'Disguised' }),
        ],
        templateResources: { Disguised: res('AWS::IAM::Role', providerRole()) },
      }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
    // 🔴 理由コードだけでは足りない（M38 の再ドリルで判明）。食い違い検査を外しても
    // 別経路が同じ `opaqueResourceShape` を返して緑のままだった。**根拠まで固定する。**
    expect(verdict.blocks[0]!.evidence).toContain('種別が食い違います');
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
    ['インラインで iam: を許可する', providerRole({ Policies: inlineWith('iam:PutRolePolicy') })],
    [
      'インラインで Action:* を許可する',
      providerRole({ Policies: inlineWith('*') }),
    ],
    // 🔴 レビュー Blocking 2: 旧実装は `iam:` のように**コロン込みの接頭辞**で
    // `startsWith` していたので、下の 4 つはどれも素通りしていた。どれも IAM が
    // 受け付ける正当な action 文字列であり、指している操作は同じである。
    ['インラインで iam* を許可する（コロン無し）', providerRole({ Policies: inlineWith('iam*') })],
    ['インラインで sts* を許可する', providerRole({ Policies: inlineWith('sts*') })],
    ['インラインで *:* を許可する', providerRole({ Policies: inlineWith('*:*') })],
    ['インラインで *:CreateRole を許可する', providerRole({ Policies: inlineWith('*:CreateRole') })],
    // 🔴 レビュー（2026-08-13）: action の許可リストだけでは残余が
    // 「アカウント全体の SSM 読み書き削除」だった。`Resource` も実測へ閉じ込める。
    [
      '許可リストの action を Resource:* で載せる（ssm:DeleteParameters が account 全体に効く）',
      providerRole({ Policies: inlineWith('ssm:DeleteParameters', '*') }),
    ],
    [
      '許可リストの action を parameter/* で載せる（cdk/exports の外へ出る）',
      providerRole({
        Policies: inlineWith('ssm:GetParameters', 'arn:aws:ssm:us-east-1:822063948773:parameter/*'),
      }),
    ],
    [
      'Resource のリージョンとアカウントを * にする',
      providerRole({ Policies: inlineWith('ssm:GetParameters', 'arn:aws:ssm:*:*:parameter/cdk/exports/*') }),
    ],
    [
      'Resource のアカウントだけ別アカウントにする',
      providerRole({
        Policies: inlineWith('ssm:GetParameters', 'arn:aws:ssm:us-east-1:111122223333:parameter/cdk/exports/*'),
      }),
    ],
    [
      'Resource を静的に読めない値にする',
      providerRole({ Policies: inlineWith('ssm:GetParameters', { 'Fn::GetAtt': ['X', 'Arn'] }) }),
    ],
    [
      'Resource を NotResource（これ以外すべて）で書く',
      providerRole({
        Policies: [
          {
            PolicyName: 'Inline',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Action: 'ssm:GetParameters', NotResource: 'arn:aws:ssm:us-east-1:822063948773:parameter/nothing' },
              ],
            },
          },
        ],
      }),
    ],
    [
      'Resource を書かない',
      providerRole({
        Policies: [
          {
            PolicyName: 'Inline',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: 'ssm:GetParameters' }],
            },
          },
        ],
      }),
    ],
    // 🔴 レビュー「classifyTrustPolicy が Action を見ていない」。
    [
      'trust policy の Action を AssumeRoleWithWebIdentity にする',
      providerRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
            },
          ],
        },
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

/**
 * 🔴 **#680 R10 フォローアップ（レビュー Blocking 1）。**
 *
 * 「論理 ID だけの allowlist はほぼ無価値」という洞察を、**隣のリソース種別へ
 * 持ち越していなかった**。ロールの形をいくら固定しても、権限は
 * `AWS::IAM::Policy` / `ManagedPolicy` / `RolePolicy` から**別リソースとして**
 * 同じロールに届く。IAM 側も `AllowCdkProviderRoleMutationWithoutBoundary` で
 * `iam:PutRolePolicy` / `AttachRolePolicy` を carve-out ARN に対して無条件に許している。
 */
describe('A: 権限は隣のリソース種別から carve-out ロールへ届く (#680 R10 フォローアップ)', () => {
  const adminDocument = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
  };
  /** provider が実際に使う形（action も Resource も実測どおり）。 */
  const ssmDocument = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['ssm:GetParameters'], Resource: SSM_EXPORTS_ARN('*') }],
  };
  /** action は許可リスト内だが Resource が account 全体に開いている。 */
  const wideSsmDocument = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['ssm:DeleteParameters'], Resource: '*' }],
  };

  /** provider role 本体 + それを狙う別リソース、という 2 リソースの change set。 */
  const attachmentVerdict = (
    type: string,
    attachmentProps: TemplateProperties,
    opts: { readonly action?: string; readonly includeRole?: boolean } = {},
  ) => {
    const includeRole = opts.includeRole ?? true;
    return evaluateDeployChangeSet(
      summary({
        changes: [
          ...(includeRole ? [roleChange(EXPORT_WRITER_ROLE!)] : []),
          change({
            action: opts.action ?? 'Add',
            resourceType: type,
            logicalResourceId: 'Attachment',
            replacement: undefined,
          }),
        ],
        templateResources: {
          [EXPORT_WRITER_ROLE!]: res('AWS::IAM::Role', providerRole()),
          Attachment: res(type, attachmentProps),
        },
      }),
    );
  };

  it.each(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'] as const)(
    '%s が Ref で carve-out ロールへ Action:* を付けるのは止める',
    (type) => {
      const verdict = attachmentVerdict(type, {
        PolicyDocument: adminDocument,
        Roles: [{ Ref: EXPORT_WRITER_ROLE }],
      });
      expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
    },
  );

  it('AWS::IAM::RolePolicy（3 つ目の綴り）も同じ場所で覆う', () => {
    const verdict = attachmentVerdict('AWS::IAM::RolePolicy', {
      PolicyName: 'Evil',
      PolicyDocument: adminDocument,
      RoleName: { Ref: EXPORT_WRITER_ROLE },
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('🔴 ロールが change set に一度も現れなくても止める（承認済みロールへの後付け）', () => {
    // Modify のみ。既に承認済みの provider role を、後日のデプロイで Admin にする経路。
    const verdict = attachmentVerdict(
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: adminDocument, Roles: [{ Ref: EXPORT_WRITER_ROLE }] },
      { action: 'Modify', includeRole: false },
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  // 🔴 隣のリソース種別への移設（このラウンドで足した `Resource` 検査が、
  // ロール本体の `Policies` だけでなくここにも掛かっていることの確認）。
  it.each(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'] as const)(
    '%s が carve-out ロールへ「許可 action ＋ Resource:*」を付けるのも止める',
    (type) => {
      const verdict = attachmentVerdict(type, {
        PolicyDocument: wideSsmDocument,
        Roles: [{ Ref: EXPORT_WRITER_ROLE }],
      });
      expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
      expect(verdict.blocks[0]!.evidence).toContain('許可リストの外の Resource');
    },
  );

  it('AWS::IAM::RolePolicy 経由でも Resource:* は止める', () => {
    const verdict = attachmentVerdict('AWS::IAM::RolePolicy', {
      PolicyName: 'Wide',
      PolicyDocument: wideSsmDocument,
      RoleName: { Ref: EXPORT_WRITER_ROLE },
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('carve-out ロールへ provider が実際に使う ssm アクションだけを付けるのは通る', () => {
    const verdict = attachmentVerdict('AWS::IAM::Policy', {
      PolicyDocument: ssmDocument,
      Roles: [{ Ref: EXPORT_WRITER_ROLE }],
    });
    expect(verdict.blocks).toEqual([]);
  });

  it('🔴 空虚に真になっていないことの対照: carve-out の外のロールへの Policy は通る', () => {
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [
          change({
            action: 'Add',
            resourceType: 'AWS::IAM::Policy',
            logicalResourceId: 'Attachment',
            replacement: undefined,
          }),
        ],
        templateResources: {
          ServerFnServiceRole: res('AWS::IAM::Role', lambdaServiceRole()),
          Attachment: res('AWS::IAM::Policy', {
            PolicyDocument: adminDocument,
            Roles: [{ Ref: 'ServerFnServiceRole' }],
          }),
        },
      }),
    );
    // boundary が天井になるので止めない（記録だけ）。
    expect(verdict.blocked).toBe(false);
    expect(verdict.flags.map((f) => f.reason)).toContain('iamPolicyChange');
  });

  it('🔴 Ref 先がロールでない（別種別に role 名を持たせる）なら止める', () => {
    // `Ref` は SSM Parameter の `Name` を返す。carve-out の実在ロール名を書けば
    // 「ロールの形」検査を一切通らずに権限が届く。**Type を見ないと防げない。**
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [
          change({
            action: 'Add',
            resourceType: 'AWS::IAM::Policy',
            logicalResourceId: 'Attachment',
            replacement: undefined,
          }),
        ],
        templateResources: {
          Decoy: res('AWS::SSM::Parameter', {
            Name: 'OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw',
          }),
          Attachment: res('AWS::IAM::Policy', {
            PolicyDocument: adminDocument,
            Roles: [{ Ref: 'Decoy' }],
          }),
        },
      }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });

  it('🔴 リテラルのロール名は「carve-out の外」だと証明できないので同じ検査を掛ける', () => {
    // `Path` が分からない以上、名前だけでは非所属を示せない（グロブの `*` は `/` を跨ぐ）。
    const verdict = attachmentVerdict(
      'AWS::IAM::Policy',
      { PolicyDocument: adminDocument, Roles: ['SomePreexistingRole'] },
      { includeRole: false },
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('Roles が静的に解決できない（Fn::Join）なら止める', () => {
    const verdict = attachmentVerdict(
      'AWS::IAM::Policy',
      { PolicyDocument: ssmDocument, Roles: [{ 'Fn::Join': ['', ['a', 'b']] }] },
      { includeRole: false },
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });

  // 以下 4 件は「payload を隣の綴りへ移す」変異ドリル（N1/N2/N4/N5）から昇格した。
  it('role.ManagedPolicyArns がテンプレート内の ManagedPolicy への Ref でも止める', () => {
    const verdict = evaluateRoleFixture(
      EXPORT_WRITER_ROLE!,
      providerRole({ ManagedPolicyArns: [{ Ref: 'EvilManagedPolicy' }] }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('付与ポリシーを NotAction（これ以外すべて）で書いても止める', () => {
    const verdict = attachmentVerdict('AWS::IAM::Policy', {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', NotAction: 'ec2:*', Resource: '*' }],
      },
      Roles: [{ Ref: EXPORT_WRITER_ROLE }],
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('Path で carve-out に入れたロールへ別リソースから付与するのも止める（2 経路の合わせ技）', () => {
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [
          change({
            action: 'Add',
            resourceType: 'AWS::IAM::Policy',
            logicalResourceId: 'Attachment',
            replacement: undefined,
          }),
        ],
        templateResources: {
          Innocent: res('AWS::IAM::Role', providerRole({ Path: '/OpenReception-x-dev-Custom/' })),
          Attachment: res('AWS::IAM::Policy', {
            PolicyDocument: adminDocument,
            Roles: [{ Ref: 'Innocent' }],
          }),
        },
      }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('carve-out の内と外へ 1 つの Policy でまとめて付けても、内側を見落とさない', () => {
    const verdict = evaluateDeployChangeSet(
      summary({
        changes: [
          change({
            action: 'Add',
            resourceType: 'AWS::IAM::Policy',
            logicalResourceId: 'Attachment',
            replacement: undefined,
          }),
        ],
        templateResources: {
          [EXPORT_WRITER_ROLE!]: res('AWS::IAM::Role', providerRole()),
          ServerFnServiceRole: res('AWS::IAM::Role', lambdaServiceRole()),
          Attachment: res('AWS::IAM::Policy', {
            PolicyDocument: adminDocument,
            Roles: [{ Ref: 'ServerFnServiceRole' }, { Ref: EXPORT_WRITER_ROLE }],
          }),
        },
      }),
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['carveOutRoleShape']);
  });

  it('Users / Groups へポリシーを付けるのは止める（dev に IAM プリンシパルは無い）', () => {
    const verdict = attachmentVerdict(
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: ssmDocument, Users: ['someone'] },
      { includeRole: false },
    );
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['iamPrincipalChange']);
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

  /**
   * 🔴 **`AWS::IAM::OIDCProvider` の Add は gate を通る**（変異ドリル N6）。
   * 通してよいのは「プロバイダ単体では誰にも何も許さない」からで、その前提は
   * **`Federated` を信頼するロールが必ず止まること**に全面的に依存している。
   * 依存先をここで固定する（carve-out の中は `carveOutRoleShape` が別途固定済み）。
   */
  it('carve-out の外でも Federated を信頼するロールは止める（OIDC プロバイダを無害にしている前提）', () => {
    const verdict = evaluateRoleFixture(
      'ServerFnServiceRole',
      lambdaServiceRole({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Principal: {
                Federated: 'arn:aws:iam::822063948773:oidc-provider/token.actions.githubusercontent.com',
              },
            },
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
  const urlVerdict = (
    logicalId: string,
    authType: unknown,
    action = 'Add',
    target: unknown = { 'Fn::GetAtt': [URL_TARGETS[logicalId] ?? 'EvilFn', 'Arn'] },
  ) =>
    evaluateDeployChangeSet(
      summary({
        changes: [
          change({ action, resourceType: 'AWS::Lambda::Url', logicalResourceId: logicalId, replacement: undefined }),
        ],
        templateResources: {
          [logicalId]: res('AWS::Lambda::Url', { AuthType: authType, TargetFunctionArn: target }),
        },
      }),
    );

  it('🔴 論理 ID だけ allowlist を名乗り、実体は別の関数へ向ける URL は止める', () => {
    // 初回デプロイでは全リソースが Add なので、この論理 ID を本物の ServerFn に
    // 付けることを強制するものが他に無い。名前ではなく**向き先**を固定する。
    const verdict = urlVerdict(SERVER_URL, 'NONE', 'Add', { 'Fn::GetAtt': ['EvilFn', 'Arn'] });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('TargetFunctionArn が GetAtt でなければ止める（リテラル ARN も含む）', () => {
    const verdict = urlVerdict(SERVER_URL, 'NONE', 'Add', 'arn:aws:lambda:ap-northeast-1:111122223333:function:evil');
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('🔴 GetAtt の属性が Arn でなければ止める（同じ関数を指していても）', () => {
    // 変異ドリル M39 が生き残って見つけた穴。属性を見ないと
    // `Fn::GetAtt: [X, 'FunctionName']` のような別物が Arn として通る。
    const verdict = urlVerdict(SERVER_URL, 'NONE', 'Add', {
      'Fn::GetAtt': [SERVER_FN, 'FunctionName'],
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('GetAtt の短縮形（"論理 ID.Arn"）も同じ 1 本として通す', () => {
    // CloudFormation が受け付ける別の綴り。片方だけ扱うと検査を迂回させられる。
    expect(urlVerdict(SERVER_URL, 'NONE', 'Add', { 'Fn::GetAtt': `${SERVER_FN}.Arn` }).blocks).toEqual(
      [],
    );
  });

  it('🔴 空虚に真になっていないことの対照: WebStack の 2 本は両方式とも通る', () => {
    // `Web-dev` の作り直し（全リソースが Add）が gate で止まってはならない。
    expect(urlVerdict(SERVER_URL, 'AWS_IAM').blocks).toEqual([]); // OAC 方式
    expect(urlVerdict(SERVER_URL, 'NONE').blocks).toEqual([]); // origin-verify 方式
    expect(urlVerdict(IMAGE_URL, 'AWS_IAM').blocks).toEqual([]);
  });

  it('未知の Function URL の Add は止める（無条件許可でも無条件停止でもない）', () => {
    const verdict = urlVerdict('EvilFnFunctionUrlDEADBEEF', 'NONE');
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('image の Function URL を NONE へ倒す Modify は止める (#631)', () => {
    const verdict = urlVerdict(IMAGE_URL, 'NONE', 'Modify');
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['functionUrlExposure']);
  });

  it('AuthType がリテラルでなければ止める', () => {
    const verdict = urlVerdict(SERVER_URL, { Ref: 'AuthParam' });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['opaqueResourceShape']);
  });

  const permVerdict = (logicalId: string, principal: unknown, over: TemplateProperties = {}) =>
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
        templateResources: {
          [logicalId]: res('AWS::Lambda::Permission', {
            Principal: principal,
            Action: 'lambda:InvokeFunctionUrl',
            FunctionName: { 'Fn::GetAtt': [PERMISSION_TARGETS[logicalId] ?? SERVER_FN, 'Arn'] },
            SourceArn: `arn:aws:cloudfront::${ACCOUNT}:distribution/E123`,
            ...over,
          }),
        },
      }),
    );

  it('CloudFront への OAC 許可は通る（論理 ID を数え上げずに済む形にしてある）', () => {
    expect(permVerdict('DistributionOacPermission', 'cloudfront.amazonaws.com').blocks).toEqual([]);
  });

  it('CDK が組む擬似パラメータ入りの SourceArn（Fn::Join）も通る', () => {
    // 実測: `arn:` + Ref(AWS::Partition) + `:cloudfront::` + Ref(AWS::AccountId) + …
    const verdict = permVerdict('DistributionOriginInvoke', 'cloudfront.amazonaws.com', {
      SourceArn: {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':cloudfront::',
            { Ref: 'AWS::AccountId' },
            ':distribution/',
            { Ref: 'Distribution830FAC52' },
          ],
        ],
      },
    });
    expect(verdict.blocks).toEqual([]);
  });

  it('🔴 サービスプリンシパルでも source 条件が無ければ止める（別アカウントの API から呼べる）', () => {
    const verdict = permVerdict('ApiGatewayInvoke', 'apigateway.amazonaws.com', {
      SourceArn: undefined,
      SourceAccount: undefined,
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['publicInvokePermission']);
  });

  it('🔴 source 条件が静的に読めなければ止める（読めなかったを「自アカウント」に落とさない）', () => {
    // 変異ドリル M36 が生き残って見つけた穴。解決できない値をアカウント一致に
    // 丸めると、`SourceArn` に任意の組み込み関数を書くだけで source 条件を無効化できる。
    for (const sourceArn of [
      // 値ごと読めない
      { 'Fn::GetAtt': ['SomethingElse', 'Arn'] },
      // 🔴 ARN の形はしているが**アカウント欄だけ**が読めない（M38 の再ドリルで追加）。
      // テンプレートパラメータで後から差し込む形。ここを「一致」に丸めると
      // source 条件は名ばかりになる。
      { 'Fn::Join': ['', ['arn:aws:cloudfront::', { Ref: 'AccountParam' }, ':distribution/E1']] },
    ]) {
      const verdict = permVerdict('OpaqueSourceInvoke', 'cloudfront.amazonaws.com', { SourceArn: sourceArn });
      expect(verdict.blocks.map((b) => b.reason)).toEqual(['publicInvokePermission']);
    }
  });

  it('🔴 source 条件が別アカウントを名指ししていれば止める', () => {
    const verdict = permVerdict('ForeignSourceInvoke', 'cloudfront.amazonaws.com', {
      SourceArn: 'arn:aws:cloudfront::111122223333:distribution/E999',
    });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['publicInvokePermission']);
  });

  it('SourceAccount で自アカウントを名指しするのも通る', () => {
    const verdict = permVerdict('S3NotifyInvoke', 's3.amazonaws.com', {
      SourceArn: undefined,
      SourceAccount: ACCOUNT,
    });
    expect(verdict.blocks).toEqual([]);
  });

  it('origin-verify 方式で CDK が足す Principal:"*" の 2 本は通る', () => {
    for (const id of Object.keys(REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions)) {
      expect(permVerdict(id, '*').blocks).toEqual([]);
    }
  });

  it('未知の Principal:"*" invoke 許可は止める（資格情報が切れても残る）', () => {
    expect(permVerdict('EvilPublicInvoke', '*').blocks.map((b) => b.reason)).toEqual([
      'publicInvokePermission',
    ]);
  });

  it('🔴 allowlist 済みの論理 ID を名乗る Principal:"*" でも、別の関数を指していれば止める', () => {
    const [known] = Object.keys(REVIEWED_CDK_GENERATED_LOGICAL_IDS.publicInvokePermissions);
    const verdict = permVerdict(known!, '*', { FunctionName: { 'Fn::GetAtt': ['EvilFn', 'Arn'] } });
    expect(verdict.blocks.map((b) => b.reason)).toEqual(['publicInvokePermission']);
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
