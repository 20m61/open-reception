import * as cdk from 'aws-cdk-lib';

/**
 * Claude Cloud からの無人 dev デプロイ用 Permissions Boundary の適用 (#680 / ADR 0009 層 4)。
 *
 * ## なぜアプリ側で適用しなければならないのか
 *
 * `cdk bootstrap --custom-permissions-boundary` が boundary を付けるのは
 * `CloudFormationExecutionRole` **1 つだけ**である
 * （`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml` の
 * `CloudFormationExecutionRole.Properties.PermissionsBoundary`。deploy /
 * file-publishing / image-publishing / lookup の各ロールには付かない）。
 * **CDK アプリが作る `AWS::IAM::Role` には何も付かない。**
 *
 * 一方 `scripts/aws-policies/claude-cfn-exec.json` と `claude-boundary.json` は
 * `iam:CreateRole` / `iam:PutRolePolicy` / `iam:AttachRolePolicy` を
 * 「`iam:PermissionsBoundary` がこの boundary であること」を条件にしてしか許さず、
 * 条件を満たさないものは `StringNotEquals`（キー欠如時に true）で明示 Deny する。
 * したがってアプリ側で boundary を適用しないと、**最初の CREATE で
 * `iam:CreateRole` が Deny されて AccessDenied → ロールバックする**
 * （`OpenReception-CfMonitoring-dev` は `crossRegionReferences: true` の
 * custom resource Lambda ＋ `AWS::IAM::Role` を含む新規スタック）。
 *
 * ## なぜ `-c @aws-cdk/core:permissionsBoundary={"name":"..."}` ではだめか
 *
 * CDK CLI の `parseStringContextListToObject`
 * （`infra/node_modules/aws-cdk/lib/index.js`）は `-c key=value` の value を
 * **生の文字列のまま** context へ入れる（JSON へパースしない）。一方
 * `Stack.permissionsBoundaryArn`（`aws-cdk-lib/core/lib/stack.js`）は
 * `context.arn` / `context.name` を**プロパティとして**読むため、文字列を渡すと
 * どちらも `undefined` になり、`arn` が決まらず Aspect も追加されない ——
 * **警告もエラーも出ない完全な no-op** になる。
 * `infra/test/claude-deploy-boundary.test.ts` がこの罠を回帰テストとして固定している。
 *
 * そこでこの関数は「ポリシー**名**という素の文字列」を専用 context キー
 * `claudeBoundary` から受け取り、CDK が内部で使うのと同じ `{ name }` 形へ変換して
 * App の context に据える（`PermissionsBoundary.fromName(...)._bind(scope)` と等価。
 * `_bind` は internal なので公開 API の `Node.setContext` を使う）。
 *
 * ## なぜ無条件に適用しないのか
 *
 * `claude-boundary.json` は dev の Claude 経路が必要とするサービスだけを Allow する
 * 天井である。無条件に適用すると、人間が staging / prod をデプロイするときにも
 * アプリのロールへこの天井が掛かり、`secretsmanager:*`（`appSecretsName` /
 * `providerSecretBackend=secrets-manager`）などが実行時に効かなくなって壊れる。
 * `scripts/aws-cloud-deploy.sh`（dev 専用）だけがこの context を渡す。
 *
 * @param app 子（Stack）を 1 つも作る前の App。`Stack` の constructor が
 *            `node.tryGetContext` を読むため、**必ず最初に呼ぶ**。
 */
export function applyClaudeDeployBoundary(app: cdk.App): void {
  const policyName = app.node.tryGetContext(CLAUDE_BOUNDARY_CONTEXT_KEY) as unknown;
  if (policyName === undefined) return;

  // 空文字（`-c claudeBoundary=$UNSET_VAR`）を「未指定」に落とすと、boundary が付かないまま
  // deploy が始まり、原因の分かりにくい AccessDenied になる。判定不能は fail-closed にする。
  if (typeof policyName !== 'string' || policyName.trim() === '') {
    throw new Error(
      `-c ${CLAUDE_BOUNDARY_CONTEXT_KEY}= には Permissions Boundary の**ポリシー名**が必要です` +
        `（空文字・非文字列は不可。実際: ${JSON.stringify(policyName)}）。` +
        `例: -c ${CLAUDE_BOUNDARY_CONTEXT_KEY}=OpenReceptionClaudeBoundary`,
    );
  }

  app.node.setContext(cdk.PERMISSIONS_BOUNDARY_CONTEXT_KEY, { name: policyName.trim() });
}

/** `scripts/aws-cloud-deploy.sh` が `-c <key>=<policy-name>` で渡す context キー。 */
export const CLAUDE_BOUNDARY_CONTEXT_KEY = 'claudeBoundary';
