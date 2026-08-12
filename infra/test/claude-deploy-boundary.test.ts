/**
 * Claude Cloud 経路の Permissions Boundary 適用 (#680 / ADR 0009 層 4 / Critical 2)。
 *
 * ここで固定したいのは 3 つ:
 *  1. context を渡したとき、App 配下の **すべての `AWS::IAM::Role`** に
 *     `PermissionsBoundary` が付く（＝`claude-cfn-exec.json` の
 *     `DenyRoleCreationWithoutBoundary` に当たらない）
 *  2. context を渡さないとき（人間の staging / prod デプロイ）は付かない
 *  3. 🔴 **CDK 標準の context キーへ「文字列」を渡すと no-op になる**という罠。
 *     `-c @aws-cdk/core:permissionsBoundary={"name":"..."}` はまさにこれをやるので
 *     使えない。この性質が変わったら（＝CDK が文字列も解釈するようになったら）
 *     このテストが落ちて、実装を単純化してよいことに気づける。
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLAUDE_BOUNDARY_CONTEXT_KEY,
  applyClaudeDeployBoundary,
} from '../lib/config/claude-deploy-boundary';
import { applyCostTags } from '../lib/constructs/cost-tags';
import { resolveEnv } from '../lib/config/environments';

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
 * - `lambda.Function`（実行ロールが暗黙に作られる。初回 CREATE で問題になるのはこちら
 *   ―― `crossRegionReferences: true` の custom resource が同じ形で Role を作る）
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
