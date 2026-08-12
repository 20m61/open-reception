/**
 * Claude Cloud 経路の Permissions Boundary 適用 (#680 / ADR 0009 層 4 / Critical 2)。
 *
 * ここで固定したいのは 4 つ:
 *  1. context を渡したとき、**construct として作られる** `AWS::IAM::Role` に
 *     `PermissionsBoundary` が付く（＝`claude-cfn-exec.json` の
 *     `DenyRoleCreationWithoutBoundary` に当たらない）
 *  2. context を渡さないとき（人間の staging / prod デプロイ）は付かない
 *  3. 🔴 **CDK 標準の context キーへ「文字列」を渡すと no-op になる**という罠。
 *     `-c @aws-cdk/core:permissionsBoundary={"name":"..."}` はまさにこれをやるので
 *     使えない。この性質が変わったら（＝CDK が文字列も解釈するようになったら）
 *     このテストが落ちて、実装を単純化してよいことに気づける。
 *  4. 🔴 **R1（#680 残件）: `CustomResourceProvider` が吐く生の `AWS::IAM::Role` は
 *     この Aspect の外にいる。** boundary もタグも付かないものが残るので、契約は
 *     「全部に付く」ではなく「付かないものは carve-out の名前パターンに収まる」。
 *     `CustomResourceProvider 系ロール (#680 R1)` describe を参照。
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLAUDE_BOUNDARY_CONTEXT_KEY,
  applyClaudeDeployBoundary,
} from '../lib/config/claude-deploy-boundary';
import { applyCostTags } from '../lib/constructs/cost-tags';
import { resolveEnv } from '../lib/config/environments';
import {
  cfnGeneratedNamePrefix,
  iamArnGlobMatches,
} from '../../src/domain/governance/cfn-generated-name';

const ACCOUNT = '822063948773';
/**
 * CDK は boundary ARN を partition 疑似パラメータ込みで組み立てるため、合成後の
 * テンプレートでは平文文字列ではなく `Fn::Join` になる。**形ごと固定する** ——
 * 「`OpenReceptionClaudeBoundary` を含む何か」で緩めると、account やポリシー名が
 * ずれても通ってしまう。
 */
const BOUNDARY_ARN = {
  'Fn::Join': [
    '',
    ['arn:', { Ref: 'AWS::Partition' }, `:iam::${ACCOUNT}:policy/OpenReceptionClaudeBoundary`],
  ],
};

/**
 * boundary 適用後に「Role を作る典型的なもの」を 2 種類置いたスタックを synth する。
 * - 明示的な `iam.Role`
 * - `lambda.Function`（実行ロールが暗黙に作られる）
 *
 * 🔴 **この fixture は `CustomResourceProvider` 系のロールを含まない。**
 * `crossRegionReferences` / `autoDeleteObjects` の provider role は
 * `AWS::IAM::Role` を**生の CloudFormation リソースとして**吐き、`ITaggable` でもなく、
 * cross-region のものは `prepareApp`（synth 中）で materialise されるため
 * `Stack.addPermissionsBoundaryAspect()` の Aspect より**後**に生える。
 * その等価性が無いことは下の `CustomResourceProvider 系ロール` describe が固定する。
 */
function synth(context?: Record<string, unknown>): Template {
  const app = new cdk.App({ context });
  applyClaudeDeployBoundary(app);
  const stack = new cdk.Stack(app, 'BoundaryTest', {
    env: { account: ACCOUNT, region: 'ap-northeast-1' },
  });
  new iam.Role(stack, 'ExplicitRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  new lambda.Function(stack, 'ImplicitRoleViaFunction', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
  });
  return Template.fromStack(stack);
}

/** `findResources` の戻り値から論理 ID の Properties を取り出す（noUncheckedIndexedAccess 対応）。 */
function propertiesOf(
  resources: Record<string, { Properties?: unknown }>,
  logicalId: string,
): Record<string, unknown> {
  const entry = resources[logicalId];
  if (entry === undefined) throw new Error(`論理 ID が見つかりません: ${logicalId}`);
  return (entry.Properties ?? {}) as Record<string, unknown>;
}

/** テンプレート内の唯一の Role の Properties を取り出す（0 件なら throw）。 */
function onlyRoleProperties(template: Template): Record<string, unknown> {
  const roles = template.findResources('AWS::IAM::Role');
  const ids = Object.keys(roles);
  expect(ids).toHaveLength(1);
  return propertiesOf(roles, ids[0]!);
}

/** テンプレート内の全 `AWS::IAM::Role` の `PermissionsBoundary` プロパティを返す。 */
function boundariesOfEveryRole(template: Template): ReadonlyArray<unknown> {
  const roles = template.findResources('AWS::IAM::Role');
  const ids = Object.keys(roles);
  // 🔴 0 件なら「全部に付いている」が空虚に真になる。対象が実在することを先に固定する。
  expect(ids.length).toBeGreaterThanOrEqual(2);
  return ids.map((id) => propertiesOf(roles, id).PermissionsBoundary);
}

describe('applyClaudeDeployBoundary (#680 Critical 2)', () => {
  it('context を渡すと App 配下の全 Role に PermissionsBoundary が付く', () => {
    const template = synth({ [CLAUDE_BOUNDARY_CONTEXT_KEY]: 'OpenReceptionClaudeBoundary' });
    for (const boundary of boundariesOfEveryRole(template)) {
      expect(boundary).toEqual(BOUNDARY_ARN);
    }
  });

  it('context を渡さなければ付かない（人間の staging / prod デプロイを壊さない）', () => {
    for (const boundary of boundariesOfEveryRole(synth())) {
      expect(boundary).toBeUndefined();
    }
  });

  it('空文字は「未指定」に落とさず throw する（fail-closed）', () => {
    expect(() => synth({ [CLAUDE_BOUNDARY_CONTEXT_KEY]: '' })).toThrow(/ポリシー名/);
    expect(() => synth({ [CLAUDE_BOUNDARY_CONTEXT_KEY]: '   ' })).toThrow(/ポリシー名/);
  });

  it('非文字列も throw する（判定不能を素通りさせない）', () => {
    expect(() => synth({ [CLAUDE_BOUNDARY_CONTEXT_KEY]: { name: 'X' } })).toThrow(/ポリシー名/);
  });

  // 🔴 これが Critical 2 の中心。CDK CLI は `-c key=value` の value を JSON へパースせず
  // 生の文字列として context に入れる（`parseStringContextListToObject`）。
  // `Stack.permissionsBoundaryArn` は `context.arn` / `context.name` をプロパティとして
  // 読むので、文字列を渡すと両方 `undefined` になり **警告もエラーも出さず no-op** になる。
  // つまり `-c '@aws-cdk/core:permissionsBoundary={"name":"..."}'` は効かない。
  it('CDK 標準キーへ文字列（CLI が渡す形）を入れても boundary は付かない = no-op の罠', () => {
    const app = new cdk.App({
      context: { [cdk.PERMISSIONS_BOUNDARY_CONTEXT_KEY]: '{"name":"OpenReceptionClaudeBoundary"}' },
    });
    const stack = new cdk.Stack(app, 'RawStringContext', {
      env: { account: ACCOUNT, region: 'ap-northeast-1' },
    });
    new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    expect(onlyRoleProperties(Template.fromStack(stack)).PermissionsBoundary).toBeUndefined();
  });

  it('CDK 標準キーへオブジェクトを入れれば付く（上のテストが「壊れている」のではないことの対照）', () => {
    const app = new cdk.App({
      context: { [cdk.PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: 'OpenReceptionClaudeBoundary' } },
    });
    const stack = new cdk.Stack(app, 'ObjectContext', {
      env: { account: ACCOUNT, region: 'ap-northeast-1' },
    });
    new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    expect(onlyRoleProperties(Template.fromStack(stack)).PermissionsBoundary).toEqual(BOUNDARY_ARN);
  });
});

/**
 * 🔴 **R1（2026-08-12 全体レビュー残件 / #680）: 上の fixture が取り逃していたクラス。**
 *
 * `crossRegionReferences: true` と `autoDeleteObjects: true` は、CDK の
 * `CustomResourceProvider` を経由して **生の `AWS::IAM::Role`** をテンプレートへ吐く。
 * これは `iam.Role` construct ではないので:
 *
 *  - `ITaggable` ではない → `Tags.of()`（`applyCostTags`）が届かない
 *    → `Project` / `Environment` が付かない
 *  - cross-region のものは `prepareApp`（`app.synth()` の内側）で materialise される
 *    → `Stack.addPermissionsBoundaryAspect()` の Aspect が既に走った**後**なので
 *      `PermissionsBoundary` も付かない
 *
 * dev で実際に生えるのは 3 本（うち 2 本は既にアカウント上に存在する）。
 */
const ACCOUNT_ROLE_ARN_PREFIX = `arn:aws:iam::${ACCOUNT}:role/`;

/** 2 スタック 2 リージョン + 実際の cross-region 参照 + autoDeleteObjects。 */
function synthCrossRegionPair(): {
  readonly producer: Template;
  readonly consumer: Template;
  readonly producerStackName: string;
  readonly consumerStackName: string;
} {
  const app = new cdk.App({
    context: { [CLAUDE_BOUNDARY_CONTEXT_KEY]: 'OpenReceptionClaudeBoundary' },
  });
  applyClaudeDeployBoundary(app);

  const producerStackName = 'OpenReception-Web-dev';
  const consumerStackName = 'OpenReception-CfMonitoring-dev';

  const producer = new cdk.Stack(app, producerStackName, {
    env: { account: ACCOUNT, region: 'ap-northeast-1' },
    crossRegionReferences: true,
  });
  applyCostTags(producer, resolveEnv('dev'), 'web');
  // `web-stack.ts` の `autoDeleteObjects: config.environment !== 'prod'` と同じ形。
  const bucket = new s3.Bucket(producer, 'Assets', {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  const consumer = new cdk.Stack(app, consumerStackName, {
    env: { account: ACCOUNT, region: 'us-east-1' },
    crossRegionReferences: true,
  });
  applyCostTags(consumer, resolveEnv('dev'), 'cloudfront-monitoring');
  // 実際に別リージョンの値を参照する（これが ExportWriter / ExportReader を生む）。
  new cloudwatch.Alarm(consumer, 'Alarm', {
    metric: new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '5xxErrorRate',
      dimensionsMap: { DistributionId: bucket.bucketName },
    }),
    threshold: 1,
    evaluationPeriods: 1,
  });

  return {
    producer: Template.fromStack(producer),
    consumer: Template.fromStack(consumer),
    producerStackName,
    consumerStackName,
  };
}

type RoleFacts = {
  readonly stackName: string;
  readonly logicalId: string;
  readonly hasBoundary: boolean;
  readonly tags: Readonly<Record<string, string>>;
};

function rolesOf(template: Template, stackName: string): ReadonlyArray<RoleFacts> {
  const roles = template.findResources('AWS::IAM::Role');
  return Object.keys(roles).map((logicalId) => {
    const props = propertiesOf(roles, logicalId);
    const tags = (props.Tags ?? []) as ReadonlyArray<{ Key: string; Value: string }>;
    return {
      stackName,
      logicalId,
      hasBoundary: props.PermissionsBoundary !== undefined,
      tags: Object.fromEntries(tags.map((t) => [t.Key, t.Value])),
    };
  });
}

function allRoles(): ReadonlyArray<RoleFacts> {
  const { producer, consumer, producerStackName, consumerStackName } = synthCrossRegionPair();
  return [...rolesOf(producer, producerStackName), ...rolesOf(consumer, consumerStackName)];
}

/**
 * 出荷ポリシーから carve-out の ARN パターンを**読み出す**（テスト側に写経しない）。
 * 2 ファイルで一致していることも同時に固定する ―― 片方だけ直すと、cfn-exec role が
 * 許されても天井（boundary）が Deny する / その逆、という形で初回デプロイが落ちる。
 */
function carveOutPattern(): string {
  const read = (file: string): string => {
    const doc = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'scripts', 'aws-policies', file), 'utf8'),
    ) as { Statement: ReadonlyArray<{ Sid?: string; Resource?: string }> };
    const stmt = doc.Statement.find((s) => s.Sid === 'AllowCdkProviderRoleMutationWithoutBoundary');
    if (stmt?.Resource === undefined) {
      throw new Error(`${file} に AllowCdkProviderRoleMutationWithoutBoundary の Resource がありません`);
    }
    return stmt.Resource;
  };
  const exec = read('claude-cfn-exec.json');
  expect(read('claude-boundary.json')).toBe(exec);
  return exec;
}

/** そのロールが carve-out に一致するか（CloudFormation が生成する物理名を予測して判定）。 */
function matchesCarveOut(pattern: string, role: RoleFacts): boolean {
  const prefix = cfnGeneratedNamePrefix(role.stackName, role.logicalId);
  // 乱数サフィックスは未知なので、パターン側の `*` に吸わせるダミーを付ける。
  return iamArnGlobMatches(pattern, `${ACCOUNT_ROLE_ARN_PREFIX}${prefix}aBcDeFgHiJkL`);
}

describe('CustomResourceProvider 系ロール (#680 R1)', () => {
  /**
   * 🔴 **最初はこれを「全ロールに boundary とタグが付く」として書き、赤を見た。**
   * 実測（`git log` の R1 コミット / residual-fix-report）:
   *
   * | 論理 ID | boundary | Project/Environment |
   * | --- | --- | --- |
   * | `CustomS3AutoDeleteObjectsCustomResourceProviderRole…` | **付く** | 付かない |
   * | `CustomCrossRegionExportWriterCustomResourceProviderRole…` | 付かない | 付かない |
   * | `CustomCrossRegionExportReaderCustomResourceProviderRole…` | 付かない | 付かない |
   *
   * auto-delete の provider は construct 構築時に materialise されるので Aspect が届き
   * boundary は付く。cross-region の 2 本は `prepareApp` で後から生えるので届かない。
   * どれも `ITaggable` ではないのでタグは 3 本とも付かない。
   *
   * よって出荷している契約は「**全部に付く**」ではなく「**付かないものは carve-out の
   * 名前パターンに収まっている**」である。ここではその契約を固定する。
   */
  it('boundary が付かないロールは carve-out の ARN パターンに収まっている', () => {
    const pattern = carveOutPattern();
    const roles = allRoles();
    expect(roles.length).toBeGreaterThanOrEqual(3);
    const offenders = roles
      .filter((r) => !r.hasBoundary && !matchesCarveOut(pattern, r))
      .map((r) => `${r.stackName}/${r.logicalId}`);
    expect(offenders).toEqual([]);
  });

  it('Project/Environment タグが付かないロールも carve-out の ARN パターンに収まっている', () => {
    const pattern = carveOutPattern();
    const offenders = allRoles()
      .filter(
        (r) =>
          (r.tags.Project !== 'open-reception' || r.tags.Environment !== 'dev') &&
          !matchesCarveOut(pattern, r),
      )
      .map((r) => `${r.stackName}/${r.logicalId}`);
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 **上の 2 件が空虚に真になっていないことを別途固定する。** 対象が 0 本なら
   * 「収まっている」は無内容だし、逆に carve-out が全ロールを覆っていたら
   * 主境界が消えていることになる。
   */
  it('carve-out が必要なロールが実在し、かつ carve-out はそれ以外を覆っていない', () => {
    const pattern = carveOutPattern();
    const roles = allRoles();
    const covered = roles.filter((r) => matchesCarveOut(pattern, r)).map((r) => r.logicalId);
    expect(covered).toEqual([
      'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
      'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
      'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
    ]);
  });

  /**
   * carve-out が「アプリの普通のロール」まで拾わないことを、実際に synth した
   * Lambda 実行ロールで確かめる。これらは boundary もタグも付くので、
   * carve-out から外れていなければならない（外れていないと
   * `DenyIamRoleWriteOutsideProject` の免除が本番ロールへ広がる）。
   */
  it('boundary とタグが付く通常のロールは carve-out に一致しない', () => {
    const pattern = carveOutPattern();
    const app = new cdk.App({
      context: { [CLAUDE_BOUNDARY_CONTEXT_KEY]: 'OpenReceptionClaudeBoundary' },
    });
    applyClaudeDeployBoundary(app);
    const stack = new cdk.Stack(app, 'OpenReception-Web-dev', {
      env: { account: ACCOUNT, region: 'ap-northeast-1' },
    });
    applyCostTags(stack, resolveEnv('dev'), 'web');
    new lambda.Function(stack, 'ServerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
    const roles = rolesOf(Template.fromStack(stack), 'OpenReception-Web-dev');
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect({ id: role.logicalId, boundary: role.hasBoundary, carved: matchesCarveOut(pattern, role) }).toEqual(
        { id: role.logicalId, boundary: true, carved: false },
      );
    }
  });
});

/**
 * コメントを取り除く。
 *
 * 🔴 **変異実験で判明した弱さ（このテストを書いた直後の drill）**: 素の `indexOf` は
 * `// applyClaudeDeployBoundary(app);` とコメントアウトされても一致してしまい、
 * 「呼び出しを消す」という**最もありがちな退行**を検出できなかった。
 * このリポジトリには「一度も落ちたことのないアサーション」の前科があるので、
 * 検索対象からコメントを落としてから探す。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * 🔴 **Important 4 の前提を、AWS へ触れずに検証できる唯一の場所。**
 *
 * `claude-cfn-exec.json` / `claude-boundary.json` の `iam:PassRole` は
 * `aws:ResourceTag/Project` = `open-reception` かつ `aws:ResourceTag/Environment` = `dev`
 * を条件にしている。この条件は「**CDK が作る IAM Role にこの 2 タグが実際に付く**」
 * という前提の上に立っており、前提が崩れると**初回デプロイが AccessDenied で落ちる**
 * （`applyCostTags` は `Tags.of(stack)` で全 taggable リソースに付けるが、
 * `AWS::IAM::Role` が本当に taggable として扱われるかはテンプレートを見ないと分からない）。
 *
 * IAM の実評価はできないが、**タグが付くこと自体**は synth で確かめられる。
 * ここが赤くなったら、runbook ステップ 4b の 14〜16 を待たずに PassRole 条件を
 * 見直す必要がある。
 */
describe('PassRole のタグ条件が依拠する前提: CDK が IAM Role にタグを付ける (Important 4)', () => {
  it('applyCostTags 配下の AWS::IAM::Role に Project / Environment タグが付く', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TaggedRoles', {
      env: { account: ACCOUNT, region: 'ap-northeast-1' },
    });
    applyCostTags(stack, resolveEnv('dev'), 'web');
    new lambda.Function(stack, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });

    const roles = Template.fromStack(stack).findResources('AWS::IAM::Role');
    const ids = Object.keys(roles);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const tags = (propertiesOf(roles, id).Tags ?? []) as ReadonlyArray<{
        Key: string;
        Value: string;
      }>;
      const byKey = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
      expect(byKey.Project).toBe('open-reception');
      expect(byKey.Environment).toBe('dev');
    }
  });
});

describe('bin/open-reception.ts の配線', () => {
  const CODE = stripComments(readFileSync(resolve(__dirname, '..', 'bin', 'open-reception.ts'), 'utf8'));

  it('applyClaudeDeployBoundary(app) を、最初の Stack 構築より前に呼んでいる', () => {
    const call = CODE.indexOf('applyClaudeDeployBoundary(app)');
    // 🔴 マーカーが無ければ無言で PASS にせず throw する。
    if (call === -1) {
      throw new Error('bin/open-reception.ts が applyClaudeDeployBoundary(app) を呼んでいません');
    }
    const firstStack = CODE.indexOf('new WebStack(');
    if (firstStack === -1) {
      throw new Error('bin/open-reception.ts に new WebStack( が見つかりません');
    }
    expect(call).toBeLessThan(firstStack);
  });
});
