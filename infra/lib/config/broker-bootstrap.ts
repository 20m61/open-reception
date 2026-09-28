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
