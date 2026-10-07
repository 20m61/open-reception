import { pinnedStackRegion } from './stack-region';

/**
 * The CDK bootstrap qualifier dedicated to the human-managed dev-deploy broker stack
 * (owner decision 2026-09-28, #1146).
 *
 * The broker stack's CloudFormation execution role is exempt from the ledger table's and the audit
 * bucket's resource-policy Denies. That role must therefore be used for this stack only, and only a
 * human may start a deployment with it. The shared `hnb659fds` bootstrap cannot do that: its deploy
 * role is assumable account-wide and may only pass its own cfn-exec role. So the broker stack gets its
 * own bootstrap:
 * - its deploy / publishing / lookup roles trust only the owner's human principal (custom bootstrap
 *   template, a Human Gate in `docs/runbook-sparse-ledger-activation.md`);
 * - its cfn-exec role is `SparseLedgerStackDeployRoleArn`, with a policy scoped to this stack.
 *
 * The Claude chain's boundary and cfn-exec policies deny assuming or passing `role/cdk-<qualifier>-*`
 * and any access to the `cdk-<qualifier>-*` buckets (`scripts/aws-policies/`).
 * The qualifier must be ≤ 10 lowercase alphanumerics, and must differ from Claude's `orcloud01`.
 */
export const BROKER_BOOTSTRAP_QUALIFIER = 'orbrkr01';

/**
 * `SparseLedgerStackDeployRoleArn` must be exactly this bootstrap's cfn-exec role (the role the
 * synthesizer hands CloudFormation), so the Deny exemptions cannot be given to another role, such as a
 * shared bootstrap's cfn-exec role. CDK names it `cdk-<qualifier>-cfn-exec-role-<account>-<region>`.
 */
export const BROKER_STACK_DEPLOY_ROLE_ARN_PATTERN = `^arn:aws:iam::[0-9]{12}:role/cdk-${BROKER_BOOTSTRAP_QUALIFIER}-cfn-exec-role-[0-9]{12}-[a-z]{2}(-[a-z]+)+-[0-9]$`;

/**
 * The broker stack lives in exactly one region. The CDK CLI always exports `CDK_DEFAULT_REGION`
 * (from `AWS_REGION` / the profile, falling back to `us-east-1`), so `CDK_DEFAULT_REGION ?? '…'` was
 * never the fallback it looked like: an offline synth without a configured region produced a
 * `us-east-1` stack. The region is pinned, and a different configured region is refused rather than
 * silently overridden: the runbook's other commands (`aws cloudformation …`, `rollback-stack`,
 * `create-connection`) use the same shell, so a mismatch there must surface before a deploy.
 */
export const BROKER_STACK_REGION = 'ap-northeast-1';

export function brokerStackRegion(env: Readonly<Record<string, string | undefined>>): string {
  return pinnedStackRegion(env, BROKER_STACK_REGION, 'The dev deploy broker stack');
}
